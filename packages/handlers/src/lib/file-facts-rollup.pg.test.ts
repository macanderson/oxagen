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
  },
);
