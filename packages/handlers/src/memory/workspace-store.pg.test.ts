// The workspace memory store against a real migrated database
// (memory-collection spec, lane MEM5, #4912): the ranked list and its
// filters, reads by public id, a memory's uses, a memory PR by number,
// dismissal and restore with their rejections, and records added to an open
// memory PR. It runs wherever DATABASE_URL points at a migrated database, as
// store.pg.test.ts does, and a local run without one skips. Each test writes
// to a workspace of its own, and afterAll removes every row.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray } from "drizzle-orm";
import { statementHash } from "./statement";
import { postgresMemoryStore as store } from "./store";
import type { MemoryDraft, MemoryPrRecord, MemoryScope } from "./types";
import {
  postgresWorkspaceMemoryStore as workspace,
  type WorkspaceMemoryFilter,
} from "./workspace-store";

const enabled = Boolean(process.env.DATABASE_URL);

const runId = () => `tse_${crypto.randomUUID().replace(/-/g, "")}`;
const FOLDER = "/home/dev/.claude/projects/-proj/memory/";

/** A harness memory file's memory, as ingest_tacho_memories stores it. */
function fileMemory(
  statement: string,
  file: string,
  over: Partial<MemoryDraft> = {},
): MemoryDraft {
  const source = `claude-code:${FOLDER}${file}`;
  const hash = statementHash(statement);
  return {
    agentLineage: "agt.laptop",
    runPublicId: null,
    capture: "local_gateway",
    statement,
    statementHash: hash,
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [],
    source,
    dedupeKey: `local_gateway:${source}:${hash}`,
    ...over,
  };
}

describe("workspace memory store with empty input", () => {
  const bogus: MemoryScope = { orgId: "not-a-uuid", workspaceId: "not-a-uuid" };

  it("returns before any query when the id list is empty", async () => {
    await expect(workspace.findMemories(bogus, [])).resolves.toEqual([]);
    await expect(workspace.memoriesByIds(bogus, [])).resolves.toEqual([]);
    await expect(workspace.dismissMemories(bogus, [], new Date())).resolves.toEqual({
      changed: [],
      skipped: [],
      rejections: 0,
    });
    await expect(workspace.restoreMemories(bogus, [])).resolves.toEqual({
      changed: [],
      skipped: [],
      rejections: 0,
    });
    await expect(workspace.appendMemoryPrRecords(bogus, "x", [])).resolves.toBe(true);
    await expect(
      workspace.listMemories(bogus, { states: [] }, 10),
    ).resolves.toEqual({ rows: [], total: 0 });
  });
});

describe.skipIf(!enabled)("workspace memory store against Postgres", () => {
  const orgId = crypto.randomUUID();
  const workspaces: string[] = [];
  const newScope = (): MemoryScope => {
    const workspaceId = crypto.randomUUID();
    workspaces.push(workspaceId);
    return { orgId, workspaceId };
  };

  afterAll(async () => {
    if (workspaces.length > 0)
      await withSystemDb(async (tx) => {
        await tx.delete(schema.memories).where(inArray(schema.memories.workspaceId, workspaces));
        await tx
          .delete(schema.memoryRejections)
          .where(inArray(schema.memoryRejections.workspaceId, workspaces));
        await tx
          .delete(schema.memoryPullRequests)
          .where(inArray(schema.memoryPullRequests.workspaceId, workspaces));
      });
    await closeDatabase();
  });

  /** Store file memories and give each the uses named, one run per use. */
  async function seed(
    scope: MemoryScope,
    memories: Array<{ statement: string; file: string; uses?: Date[]; over?: Partial<MemoryDraft> }>,
  ) {
    for (const m of memories)
      await store.replaceSourceMemory(scope, fileMemory(m.statement, m.file, m.over));
    for (const m of memories)
      if (m.uses !== undefined && m.uses.length > 0)
        await store.recordUses(
          scope,
          m.uses.map((usedAt) => ({
            capture: "local_gateway" as const,
            source: `claude-code:${FOLDER}${m.file}`,
            runPublicId: runId(),
            signal: "read" as const,
            count: 1,
            usedAt,
          })),
        );
    const { rows } = await workspace.listMemories(
      scope,
      { states: ["waiting", "in_pr", "promoted", "dismissed", "retired"] },
      100,
    );
    const byStatement = new Map(rows.map((row) => [row.statement, row]));
    return memories.map((m) => {
      const row = byStatement.get(m.statement);
      if (row === undefined) throw new Error(`no row for ${m.statement}`);
      return row;
    });
  }

  const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));

  it("ranks by uses, then the newest use, then the newest capture", async () => {
    const scope = newScope();
    const [none, oneOld, oneNew, two] = await seed(scope, [
      { statement: "No run used this.", file: "a.md" },
      { statement: "One run used this early.", file: "b.md", uses: [at(1)] },
      { statement: "One run used this late.", file: "c.md", uses: [at(5)] },
      { statement: "Two runs used this.", file: "d.md", uses: [at(2), at(3)] },
    ]);
    const { rows, total } = await workspace.listMemories(scope, { states: ["waiting"] }, 10);
    expect(total).toBe(4);
    expect(rows.map((row) => row.publicId)).toEqual([
      two?.publicId,
      oneNew?.publicId,
      oneOld?.publicId,
      none?.publicId,
    ]);
    expect(rows[0]).toMatchObject({ useCount: 2, lastUsedAt: at(3), memoryPr: null });
  });

  it("answers at most the rows asked for, and counts every match", async () => {
    const scope = newScope();
    await seed(scope, [
      { statement: "First.", file: "a.md" },
      { statement: "Second.", file: "b.md" },
      { statement: "Third.", file: "c.md" },
    ]);
    const { rows, total } = await workspace.listMemories(scope, { states: ["waiting"] }, 2);
    expect(rows).toHaveLength(2);
    expect(total).toBe(3);
  });

  it("filters by harness, agent, repository, and type", async () => {
    const scope = newScope();
    const [claude, codex, repo, typed] = await seed(scope, [
      { statement: "Claude Code wrote this.", file: "a.md" },
      {
        statement: "Codex wrote this.",
        file: "b.md",
        over: {
          source: "codex:thread/019a",
          dedupeKey: "local_gateway:codex:thread/019a:x",
          agentLineage: "agt.other",
        },
      },
      { statement: "This one is about the api.", file: "c.md", over: { repos: ["github.com/acme/api"] } },
      { statement: "This one is feedback.", file: "d.md", over: { memoryType: "feedback" } },
    ]);
    const list = (
      filter: Pick<WorkspaceMemoryFilter, "harness" | "agent" | "repository" | "type">,
    ) =>
      workspace
        .listMemories(scope, { states: ["waiting"], ...filter }, 10)
        .then(({ rows }) => rows.map((row) => row.publicId).sort());
    expect(await list({ harness: "codex" })).toEqual([codex?.publicId]);
    expect(await list({ harness: "claude-code" })).toEqual(
      [claude?.publicId, repo?.publicId, typed?.publicId].sort(),
    );
    expect(await list({ agent: "agt.other" })).toEqual([codex?.publicId]);
    expect(await list({ repository: "github.com/acme/api" })).toEqual([repo?.publicId]);
    expect(await list({ type: "feedback" })).toEqual([typed?.publicId]);
  });

  it("finds memories by public id in any case, and only in their own workspace", async () => {
    const scope = newScope();
    const other = newScope();
    const [memory] = await seed(scope, [{ statement: "Use pnpm.", file: "a.md" }]);
    const id = memory?.publicId ?? "";
    expect((await workspace.findMemories(scope, [id.toUpperCase()])).map((m) => m.id)).toEqual([
      memory?.id,
    ]);
    expect(await workspace.findMemories(other, [id])).toEqual([]);
    expect((await workspace.memoriesByIds(scope, [memory?.id ?? ""])).map((m) => m.publicId)).toEqual([
      id,
    ]);
  });

  it("reads a memory's uses newest first and counts them", async () => {
    const scope = newScope();
    const [memory] = await seed(scope, [
      { statement: "Use pnpm.", file: "a.md", uses: [at(1), at(4), at(2)] },
    ]);
    const { uses, total } = await workspace.listUses(scope, memory?.id ?? "", 2);
    expect(total).toBe(3);
    expect(uses.map((use) => use.usedAt)).toEqual([at(4), at(2)]);
    expect(uses[0]).toMatchObject({ signal: "read", count: 1 });
  });

  it("finds a memory PR by number and by id, with the memories it cites in_pr", async () => {
    const scope = newScope();
    const [memory] = await seed(scope, [{ statement: "Use pnpm.", file: "a.md" }]);
    const record: MemoryPrRecord = {
      action: "propose",
      lineage: "use-pnpm",
      path: "steering/memory/workspace/general/use-pnpm.md",
      kind: "memory",
      memoryIds: [memory?.id ?? ""],
      statementHashes: [memory?.statementHash ?? ""],
    };
    const prId = await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      number: 41,
      url: "https://github.com/acme/steering/pull/41",
      records: [record],
    });
    const byNumber = await workspace.findMemoryPr(scope, { number: 41 });
    expect(byNumber).toMatchObject({ id: prId, status: "open", records: [record], settledAt: null });
    expect(byNumber?.publicId).toMatch(/^mpr_/);
    expect((await workspace.findMemoryPr(scope, { id: prId }))?.number).toBe(41);
    expect(await workspace.findMemoryPr(scope, { number: 42 })).toBeNull();
    const [cited] = await workspace.findMemories(scope, [memory?.publicId ?? ""]);
    expect(cited).toMatchObject({
      state: "in_pr",
      memoryPr: { id: prId, number: 41, status: "open" },
    });
  });

  it("dismisses waiting and in_pr memories, rejects their statements, and skips the rest", async () => {
    const scope = newScope();
    const [waiting, cited, promoted] = await seed(scope, [
      { statement: "Use pnpm.", file: "a.md" },
      { statement: "Pin the toolchain.", file: "b.md" },
      { statement: "Deploy from main.", file: "c.md" },
    ]);
    await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      number: 7,
      url: "https://github.com/acme/steering/pull/7",
      records: [
        {
          action: "propose",
          lineage: "pin-toolchain",
          path: "steering/memory/workspace/general/pin-toolchain.md",
          kind: "memory",
          memoryIds: [cited?.id ?? ""],
          statementHashes: [cited?.statementHash ?? ""],
        },
      ],
    });
    await store.linkMemories(scope, [{ memoryId: promoted?.id ?? "", lineage: "deploy-main" }]);

    const result = await workspace.dismissMemories(
      scope,
      [waiting?.publicId ?? "", cited?.publicId ?? "", promoted?.publicId ?? "", "mem_missing"],
      at(9),
    );

    expect(new Set(result.changed)).toEqual(new Set([waiting?.publicId, cited?.publicId]));
    expect(result.skipped).toEqual([
      { publicId: promoted?.publicId, state: "promoted" },
      { publicId: "mem_missing", state: null },
    ]);
    expect(result.rejections).toBe(2);
    const rejections = await store.listRejections(scope);
    expect(new Set(rejections.map((r) => r.statementHash))).toEqual(
      new Set([waiting?.statementHash, cited?.statementHash]),
    );
    expect(rejections.every((r) => r.rejectedAt.getTime() === at(9).getTime())).toBe(true);
  });

  it("restores a dismissed memory to waiting, or to in_pr when its open PR still cites it, and removes its rejection", async () => {
    const scope = newScope();
    const [loose, cited] = await seed(scope, [
      { statement: "Use pnpm.", file: "a.md" },
      { statement: "Pin the toolchain.", file: "b.md" },
    ]);
    await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      number: 8,
      url: "https://github.com/acme/steering/pull/8",
      records: [
        {
          action: "propose",
          lineage: "pin-toolchain",
          path: "steering/memory/workspace/general/pin-toolchain.md",
          kind: "memory",
          memoryIds: [cited?.id ?? ""],
          statementHashes: [cited?.statementHash ?? ""],
        },
      ],
    });
    const ids = [loose?.publicId ?? "", cited?.publicId ?? ""];
    await workspace.dismissMemories(scope, ids, at(9));

    const result = await workspace.restoreMemories(scope, ids);

    expect(new Set(result.changed)).toEqual(new Set(ids));
    expect(result.rejections).toBe(2);
    const states = new Map(
      (await workspace.findMemories(scope, ids)).map((m) => [m.publicId, m.state]),
    );
    expect(states.get(loose?.publicId ?? "")).toBe("waiting");
    expect(states.get(cited?.publicId ?? "")).toBe("in_pr");
    expect(await store.listRejections(scope)).toEqual([]);
    // A second restore finds nothing dismissed.
    expect((await workspace.restoreMemories(scope, ids)).skipped.map((s) => s.state)).toEqual([
      "waiting",
      "in_pr",
    ]);
  });

  it("keeps a rejection a memory PR wrote, and one another dismissed memory still holds", async () => {
    const scope = newScope();
    const [a, b, c] = await seed(scope, [
      { statement: "Use pnpm.", file: "a.md" },
      { statement: "use pnpm", file: "b.md" },
      { statement: "Pin the toolchain.", file: "c.md" },
    ]);
    // A closed memory PR rejected c's statement.
    const prId = await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-09-30",
      number: 9,
      url: "https://github.com/acme/steering/pull/9",
      records: [],
    });
    await store.settlePr(scope, {
      prId,
      status: "closed",
      settledAt: at(1),
      mergedLineages: [],
      reviewedLineages: [],
      rejectedHashes: [c?.statementHash ?? ""],
      promoted: [],
      returnedMemoryIds: [],
    });
    await workspace.dismissMemories(
      scope,
      [a?.publicId ?? "", b?.publicId ?? "", c?.publicId ?? ""],
      at(9),
    );

    // a and b share a statement, so restoring a keeps the hash b holds.
    expect((await workspace.restoreMemories(scope, [a?.publicId ?? ""])).rejections).toBe(0);
    // c's rejection names the memory PR, so a restore keeps it.
    expect((await workspace.restoreMemories(scope, [c?.publicId ?? ""])).rejections).toBe(0);
    expect(new Set((await store.listRejections(scope)).map((r) => r.statementHash))).toEqual(
      new Set([a?.statementHash, c?.statementHash]),
    );
    // Restoring b too removes the hash its dismissal wrote.
    expect((await workspace.restoreMemories(scope, [b?.publicId ?? ""])).rejections).toBe(1);
  });

  it("adds records to an open memory PR and moves the waiting memories they cite to in_pr", async () => {
    const scope = newScope();
    const [first, second, dismissed] = await seed(scope, [
      { statement: "Use pnpm.", file: "a.md" },
      { statement: "Pin the toolchain.", file: "b.md" },
      { statement: "Deploy from main.", file: "c.md" },
    ]);
    await workspace.dismissMemories(scope, [dismissed?.publicId ?? ""], at(1));
    const curated: MemoryPrRecord = {
      action: "propose",
      lineage: "use-pnpm",
      path: "steering/memory/workspace/general/use-pnpm.md",
      kind: "memory",
      memoryIds: [first?.id ?? ""],
      statementHashes: [first?.statementHash ?? ""],
    };
    const prId = await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      number: 10,
      url: "https://github.com/acme/steering/pull/10",
      records: [curated],
    });
    const added: MemoryPrRecord = {
      action: "propose",
      lineage: "pin-toolchain",
      path: "steering/memory/workspace/general/pin-toolchain.md",
      kind: "code-rule",
      memoryIds: [second?.id ?? "", dismissed?.id ?? ""],
      statementHashes: [second?.statementHash ?? ""],
    };

    expect(await workspace.appendMemoryPrRecords(scope, prId, [added])).toBe(true);

    expect((await workspace.findMemoryPr(scope, { id: prId }))?.records).toEqual([curated, added]);
    const states = new Map(
      (
        await workspace.findMemories(scope, [second?.publicId ?? "", dismissed?.publicId ?? ""])
      ).map((m) => [m.publicId, m]),
    );
    expect(states.get(second?.publicId ?? "")).toMatchObject({
      state: "in_pr",
      memoryPr: { id: prId },
    });
    // A memory that left waiting is not pulled into the PR.
    expect(states.get(dismissed?.publicId ?? "")?.state).toBe("dismissed");
  });

  it("adds nothing to a memory PR that settled", async () => {
    const scope = newScope();
    const prId = await store.insertMemoryPr(scope, {
      provider: "github",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      number: 11,
      url: "https://github.com/acme/steering/pull/11",
      records: [],
    });
    await withSystemDb((tx) =>
      tx
        .update(schema.memoryPullRequests)
        .set({ status: "merged", settledAt: at(2) })
        .where(eq(schema.memoryPullRequests.id, prId)),
    );
    expect(
      await workspace.appendMemoryPrRecords(scope, prId, [
        {
          action: "propose",
          lineage: "x",
          path: "steering/memory/workspace/general/x.md",
          kind: "memory",
          memoryIds: [],
          statementHashes: [],
        },
      ]),
    ).toBe(false);
    expect((await workspace.findMemoryPr(scope, { id: prId }))?.records).toEqual([]);
  });
});
