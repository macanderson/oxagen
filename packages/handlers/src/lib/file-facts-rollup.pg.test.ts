import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  GENESIS_CURSOR,
  sealEvent,
  type TachoEvent,
  type UnsealedTachoEvent,
} from "@oxagen/tacho";
import { eq } from "drizzle-orm";
import { rollupFiles } from "./file-facts-rollup";

// CI migrates Postgres before running this production rollup against it.
describe.skipIf(!process.env.DATABASE_URL)(
  "recorded file identity and reconciliation in Postgres",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const sessionId = crypto.randomUUID();
    const now = new Date("2026-09-20T00:00:00Z");
    let seq = 0;
    const scoped = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const clean = () =>
      scoped(() =>
        withTenantDb((tx) =>
          tx
            .delete(schema.tachoSessionFiles)
            .where(eq(schema.tachoSessionFiles.sessionId, sessionId)),
        ),
      );
    beforeEach(async () => {
      await clean();
      seq = 0;
    });
    afterAll(async () => {
      await clean();
      await closeDatabase();
    });

    function frame(
      kind: UnsealedTachoEvent["kind"],
      root: string,
      body: Record<string, unknown>,
    ): TachoEvent {
      seq += 1;
      return sealEvent(
        {
          v: "tacho/1.0",
          event_id: `evt_01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, "0")}`,
          session_id: "files",
          session_uuid: sessionId,
          root_session_uuid: sessionId,
          ts: now.toISOString(),
          fidelity: "sdk",
          source: kind === "file_io" ? "hook" : "collector",
          agent: {
            agent_key: "test.files.host",
            fleet_id: "wrk_files",
            runtime: "claude-code",
            harness: "claude-code",
            wrapper_version: "2.1.1",
          },
          kind,
          body,
          context: { worktree_path: root },
        } as UnsealedTachoEvent,
        { ...GENESIS_CURSOR, seq: seq - 1 },
      ).event;
    }
    const attested = (root: string, path = "src/a.ts") =>
      frame("file_io", root, {
        effect_kind: "file_write",
        tool_target: path,
        tool_input_bytes: 12,
      });
    const observed = (root: string, paths: string[], truncated = false) =>
      frame("oxagen:worktree_reconciled", root, {
        observed_changes: paths.map((path) => ({
          path: `${root}/${path}`,
          repo_relative_path: path,
          status: "modified",
          lines_added: 9,
          lines_removed: 2,
        })),
        observed_changes_total: paths.length,
        observed_changes_truncated: truncated,
      });
    const write = (events: TachoEvent[]) =>
      scoped(() =>
        withTenantDb((tx) =>
          rollupFiles(tx, scope, sessionId, events, now, true),
        ),
      );
    const rows = () =>
      scoped(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(schema.tachoSessionFiles)
            .where(eq(schema.tachoSessionFiles.sessionId, sessionId)),
        ),
      );

    it.each([
      ["src/a.ts", "/repo", "src/a.ts"],
      ["./src/a.ts", "/repo", "src/a.ts"],
      ["src/../src/a.ts", "/repo", "src/a.ts"],
      ["src\\a.ts", "C:/Repo", "SRC/A.ts"],
    ])(
      "keeps one stored row across attested and observed batches for %s",
      async (path, root, observedPath) => {
        await write([attested(root, path)]);
        await write([observed(root, [observedPath])]);
        const stored = await rows();
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          writes: 1,
          bytesWritten: 12,
          observedStatus: "modified",
          linesAdded: 9,
          linesRemoved: 2,
        });
      },
    );

    it("does not collapse equal relative names from different worktrees in one batch", async () => {
      await write([
        attested("/one"),
        attested("/two"),
        observed("/one", ["src/a.ts"]),
        observed("/two", ["src/a.ts"]),
      ]);
      const stored = await rows();
      expect(stored.map((row) => row.path).sort()).toEqual([
        "/one/src/a.ts",
        "/two/src/a.ts",
      ]);
      expect(
        stored.every((row) => row.writes === 1 && row.linesAdded === 9),
      ).toBe(true);
    });

    it("clears a complete empty snapshot without erasing attested history or another worktree", async () => {
      await write([
        attested("/one"),
        observed("/one", ["src/a.ts"]),
        observed("/two", ["src/a.ts"]),
      ]);
      await write([observed("/one", [])]);
      const stored = await rows();
      expect(stored.find((row) => row.path === "/one/src/a.ts")).toMatchObject({
        writes: 1,
        bytesWritten: 12,
        observedStatus: null,
        linesAdded: 0,
        linesRemoved: 0,
      });
      expect(stored.find((row) => row.path === "/two/src/a.ts")).toMatchObject({
        observedStatus: "modified",
        linesAdded: 9,
        linesRemoved: 2,
      });
    });

    it("keeps previous observations when a later snapshot is truncated", async () => {
      await write([observed("/repo", ["src/a.ts"])]);
      await write([observed("/repo", [], true)]);
      expect((await rows())[0]).toMatchObject({
        observedStatus: "modified",
        linesAdded: 9,
        linesRemoved: 2,
      });
    });

    it("uses the final complete snapshot within one batch", async () => {
      await write([observed("/repo", ["src/a.ts"]), observed("/repo", [])]);
      expect((await rows())[0]).toMatchObject({
        observedStatus: null,
        linesAdded: 0,
        linesRemoved: 0,
      });
    });

    it("does not rewrite a row a prior clean snapshot already cleared", async () => {
      await write([attested("/one"), observed("/one", ["src/a.ts"])]);
      await write([observed("/one", [])]);
      const clearedAt = (await rows()).find(
        (row) => row.path === "/one/src/a.ts",
      )?.updatedAt;
      expect(clearedAt).toBeDefined();
      // A later complete snapshot that still reports the path absent finds
      // the row already at rest (null status, zero counts) and must skip
      // it rather than issue another UPDATE: `updatedAt` stays put even
      // though this pass runs with a distinct timestamp.
      const later = new Date(now.getTime() + 60_000);
      await scoped(() =>
        withTenantDb((tx) =>
          rollupFiles(
            tx,
            scope,
            sessionId,
            [observed("/one", [])],
            later,
            true,
          ),
        ),
      );
      const stillCleared = (await rows()).find(
        (row) => row.path === "/one/src/a.ts",
      );
      expect(stillCleared?.updatedAt).toEqual(clearedAt);
      expect(stillCleared).toMatchObject({
        observedStatus: null,
        linesAdded: 0,
        linesRemoved: 0,
      });
    });

    it("enriches a stored relative path when a later absolute observation names the same file", async () => {
      await scoped(() =>
        withTenantDb((tx) =>
          tx.insert(schema.tachoSessionFiles).values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            sessionId,
            path: "src/a.ts",
            repoRelativePath: "src/a.ts",
            writes: 3,
            bytesWritten: 12,
            firstSeq: 1,
            lastSeq: 1,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
      await write([observed("/repo", ["src/a.ts"])]);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        path: "/repo/src/a.ts",
        repoRelativePath: "src/a.ts",
        writes: 3,
        bytesWritten: 12,
        observedStatus: "modified",
        linesAdded: 9,
        linesRemoved: 2,
      });
      await write([observed("/repo", [])]);
      const cleared = await rows();
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({
        path: "/repo/src/a.ts",
        writes: 3,
        bytesWritten: 12,
        observedStatus: null,
        linesAdded: 0,
        linesRemoved: 0,
      });
    });
  },
);

describe("legacy relative file identity", () => {
  const scope = {
    orgId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
  };
  const sessionId = "00000000-0000-4000-8000-000000000003";
  const now = new Date("2026-09-20T00:00:00Z");

  function seal(
    kind: UnsealedTachoEvent["kind"],
    source: UnsealedTachoEvent["source"],
    root: string,
    body: Record<string, unknown>,
  ): TachoEvent {
    return sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "files",
        session_uuid: sessionId,
        root_session_uuid: sessionId,
        ts: now.toISOString(),
        fidelity: "sdk",
        source,
        agent: {
          agent_key: "test.files.host",
          fleet_id: "wrk_files",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
        },
        kind,
        body,
        context: { worktree_path: root },
      } as UnsealedTachoEvent,
      { ...GENESIS_CURSOR, seq: 3 },
    ).event;
  }
  function reconciled(
    root: string,
    relative: string,
    changePath = `${root}/${relative}`,
  ): TachoEvent {
    return seal("oxagen:worktree_reconciled", "collector", root, {
      observed_changes: [
        {
          path: changePath,
          repo_relative_path: relative,
          status: "modified",
          lines_added: 9,
          lines_removed: 2,
        },
      ],
      observed_changes_total: 1,
      observed_changes_truncated: false,
    });
  }
  const attested = (root: string, target: string) =>
    seal("file_io", "hook", root, {
      effect_kind: "file_write",
      tool_target: target,
      tool_input_bytes: 4,
    });

  function storedRow(path: string, repoRelativePath: string | null) {
    return {
      path,
      repoRelativePath,
      linesAdded: 0,
      linesRemoved: 0,
      observedStatus: null,
    };
  }

  async function rollup(
    rows: ReturnType<typeof storedRow>[],
    events: TachoEvent[],
  ) {
    const inserted: Array<Record<string, unknown>> = [];
    const conflictSets: Array<Record<string, unknown>> = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => rows,
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => undefined,
        }),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            onConflictDoUpdate: (args: { set: Record<string, unknown> }) => {
              conflictSets.push(args.set);
              return undefined;
            },
          };
        },
      }),
    };
    await rollupFiles(
      tx as unknown as Parameters<typeof rollupFiles>[0],
      scope,
      sessionId,
      events,
      now,
      true,
    );
    return { inserted, conflictSets };
  }

  it("reuses a relative row when a later absolute observation names it", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "src/a.ts")],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      path: "src/a.ts",
      writes: 0,
      observedStatus: "modified",
      linesAdded: 9,
      linesRemoved: 2,
    });
    expect(conflictSets[0]?.path).toBe("/repo/src/a.ts");
  });

  it("does not attach a different file to a relative row", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "src/a.ts")],
      [reconciled("/repo", "src/b.ts")],
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.path).toBe("/repo/src/b.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });

  it("keeps an absolute row when a legacy relative row shares its name", async () => {
    const { inserted, conflictSets } = await rollup(
      [
        storedRow("/one/src/a.ts", "src/a.ts"),
        storedRow("src/a.ts", "src/a.ts"),
      ],
      [reconciled("/one", "src/a.ts")],
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.path).toBe("/one/src/a.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });

  it("uses the stored path when repoRelativePath is absent", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", null)],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("src/a.ts");
    expect(conflictSets[0]?.path).toBe("/repo/src/a.ts");
  });

  it("binds one relative row to one worktree when two name the same file", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "src/a.ts")],
      [reconciled("/one", "src/a.ts"), reconciled("/two", "src/a.ts")],
    );
    expect(inserted.map((row) => row.path)).toEqual([
      "src/a.ts",
      "/two/src/a.ts",
    ]);
    expect(conflictSets.map((set) => set.path)).toEqual([
      "/one/src/a.ts",
      undefined,
    ]);
  });

  it("does not treat a drive-letter path as an unqualified relative row", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("C:/repo/src/a.ts", "src/a.ts")],
      [reconciled("/other", "src/a.ts")],
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.path).toBe("/other/src/a.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });

  it("reuses a relative row for an attested write that carries no repo-relative path", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "src/a.ts")],
      [attested("/repo", "src/a.ts")],
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ path: "src/a.ts", writes: 1 });
    expect(conflictSets[0]?.path).toBe("/repo/src/a.ts");
  });

  it("indexes repoRelativePath when it differs from the stored path", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("./src/a.ts", "src/a.ts")],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("./src/a.ts");
    expect(conflictSets[0]?.path).toBe("/repo/src/a.ts");
  });

  it("falls back to the stored path when repoRelativePath is empty", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "")],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("src/a.ts");
    expect(conflictSets[0]?.path).toBe("/repo/src/a.ts");
  });

  it("keeps the first relative row when two share one repo-relative path", async () => {
    const { inserted } = await rollup(
      [
        storedRow("first/src/a.ts", "src/a.ts"),
        storedRow("second/src/a.ts", "src/a.ts"),
      ],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("first/src/a.ts");
  });

  it("does not treat a UNC path as an unqualified relative row", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("\\\\server\\share\\src\\a.ts", "src/a.ts")],
      [reconciled("/other", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("/other/src/a.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });

  it("does not rename an absolute stored path onto the batch spelling", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("/repo/./src/a.ts", "src/a.ts")],
      [reconciled("/repo", "src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("/repo/./src/a.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });

  it("does not index an absolute repoRelativePath as a legacy key", async () => {
    const { inserted, conflictSets } = await rollup(
      [storedRow("src/a.ts", "/repo/src/a.ts")],
      [reconciled("/repo", "/repo/src/a.ts", "/repo/src/a.ts")],
    );
    expect(inserted[0]?.path).toBe("/repo/src/a.ts");
    expect(conflictSets[0]?.path).toBeUndefined();
  });
});
