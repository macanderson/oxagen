// The Postgres memory store against a real migrated database (ADR-206): the
// one-reflection-per-run index, the dedupe key, the waiting queue, a memory
// PR's life from open to settled, the recall counters, the curator's
// cross-tenant listing, and the tenant policy on agent.memories. It runs
// wherever DATABASE_URL points at a migrated database. CI's `test` job
// migrates Postgres with Atlas and carries DATABASE_URL in turbo's globalEnv.
// A local run without one skips. Each test writes to a workspace of its own,
// and afterAll removes every row.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray, sql } from "drizzle-orm";
import { statementHash } from "./statement";
import { postgresMemoryStore as store } from "./store";
import type {
  MemoryDraft,
  MemoryPrRecord,
  MemoryScope,
  ReflectionDraft,
  ReflectionLesson,
} from "./types";

const enabled = Boolean(process.env.DATABASE_URL);

const runId = () => `arun_${crypto.randomUUID().replace(/-/g, "")}`;

function draft(
  statement: string,
  over: Partial<MemoryDraft> = {},
): MemoryDraft {
  const runPublicId = runId();
  const hash = statementHash(statement);
  return {
    agentLineage: "agt.memory-store-test",
    runPublicId,
    capture: "remember",
    statement,
    statementHash: hash,
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [`frame:${runPublicId}/1`],
    source: null,
    dedupeKey: `${runPublicId}:${hash}`,
    ...over,
  };
}

function reflection(
  runPublicId: string,
  statements: string[],
): ReflectionDraft {
  return {
    runPublicId,
    agentLineage: "agt.memory-store-test",
    source: "agent",
    outcome: "completed",
    summary: "Finished the task.",
    grades: { work: 4, tools: { github__create_pull_request: 5 } },
    lessons: statements.map(
      (statement): ReflectionLesson => ({
        statement,
        kind: "memory",
        evidence: [`frame:${runPublicId}/2`],
      }),
    ),
    toolFeedback: [],
  };
}

function proposal(
  lineage: string,
  cited: Array<{ id: string; statementHash: string }>,
): MemoryPrRecord {
  return {
    action: "propose",
    lineage,
    path: `steering/memory/acme/general/${lineage}.md`,
    kind: "memory",
    memoryIds: cited.map((m) => m.id),
    statementHashes: cited.map((m) => m.statementHash),
  };
}

const pullRequest = (number: number, records: MemoryPrRecord[]) => ({
  provider: "github",
  repository: "acme/steering",
  branch: `memory/2026-09-${String(number).padStart(2, "0")}`,
  number,
  url: `https://github.com/acme/steering/pull/${number}`,
  records,
});

describe("memory store with empty input", () => {
  // runInTenantScope refuses a scope whose ids are not uuids, so a method that
  // opened a transaction here would throw. Each one returns first.
  const bogus: MemoryScope = {
    orgId: "not-a-uuid",
    workspaceId: "not-a-uuid",
  };
  const at = new Date("2026-09-01T00:00:00.000Z");

  it("returns before any query when the id or lineage list is empty", async () => {
    await expect(store.insertMemories(bogus, [])).resolves.toBe(0);
    await expect(store.deleteMemories(bogus, [])).resolves.toBe(0);
    await expect(store.stampRecalls(bogus, [], at)).resolves.toBeUndefined();
    await expect(store.bumpRecalls(bogus, [], at)).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)("memory store against Postgres", () => {
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
        await tx
          .delete(schema.memories)
          .where(inArray(schema.memories.workspaceId, workspaces));
        await tx
          .delete(schema.memoryRejections)
          .where(inArray(schema.memoryRejections.workspaceId, workspaces));
        await tx
          .delete(schema.memoryRecalls)
          .where(inArray(schema.memoryRecalls.workspaceId, workspaces));
        await tx
          .delete(schema.memoryPullRequests)
          .where(inArray(schema.memoryPullRequests.workspaceId, workspaces));
        await tx
          .delete(schema.memoryReflections)
          .where(inArray(schema.memoryReflections.workspaceId, workspaces));
      });
    await closeDatabase();
  });

  it("stores one reflection per run", async () => {
    const scope = newScope();
    const run = runId();
    const first = await store.insertReflection(
      scope,
      reflection(run, ["Run the migration check before the build."]),
    );
    expect(first).toEqual(expect.any(String));
    expect(await store.hasReflection(scope, run)).toBe(true);
    expect(await store.hasReflection(scope, runId())).toBe(false);
    expect(
      await store.insertReflection(scope, reflection(run, ["Another lesson."])),
    ).toBeNull();
  });

  it("skips a memory whose dedupe key exists", async () => {
    const scope = newScope();
    const run = runId();
    const reflectionId = await store.insertReflection(
      scope,
      reflection(run, ["Prefer rg over grep."]),
    );
    const kept = draft("Prefer rg over grep.");
    expect(
      await store.insertMemories(
        scope,
        [kept, draft("Pin the lockfile.")],
        reflectionId,
      ),
    ).toBe(2);
    expect(
      await store.insertMemories(scope, [kept, draft("Write the test first.")]),
    ).toBe(1);
    // Two drafts with one key in one call write one row.
    const twice = draft("Read the failing step first.");
    expect(await store.insertMemories(scope, [twice, { ...twice }])).toBe(1);
    expect(await store.countWaiting(scope)).toBe(4);

    const waiting = await store.listWaiting(scope);
    const stored = waiting.find((m) => m.dedupeKey === kept.dedupeKey);
    expect(stored?.reflectionId).toBe(reflectionId);
    expect(
      waiting
        .filter((m) => m.dedupeKey !== kept.dedupeKey)
        .map((m) => m.reflectionId),
    ).toEqual([null, null, null]);
  });

  it("lists waiting memories oldest first and keeps nulls as null", async () => {
    const scope = newScope();
    const first = draft("Run the linter before you push.");
    const fact = "The steering repo holds governance.toml.";
    const second = draft(fact, {
      agentLineage: null,
      runPublicId: null,
      capture: "local_gateway",
      kind: "fact",
      repos: ["github.com/acme/app"],
      appliesTo: ["packages/database/**"],
      tools: ["github__create_pull_request"],
      evidence: ["file:~/.claude/projects/acme/memory/steering.md"],
      source: "claude-code:~/.claude/projects/acme/memory/steering.md",
      dedupeKey: `local_gateway:steering.md:${statementHash(fact)}`,
    });
    const third = draft("Name the failing job in the report.");
    // Separate calls commit in order, so created_at orders the three.
    await store.insertMemories(scope, [first]);
    await store.insertMemories(scope, [second]);
    await store.insertMemories(scope, [third]);

    const waiting = await store.listWaiting(scope);
    expect(waiting.map((m) => m.statement)).toEqual([
      first.statement,
      second.statement,
      third.statement,
    ]);
    expect(waiting[0]).toEqual({
      ...first,
      id: expect.any(String),
      publicId: expect.stringMatching(/^mem_/),
      reflectionId: null,
      memoryPrId: null,
      createdAt: expect.any(Date),
    });
    expect(waiting[1]).toEqual({
      ...second,
      id: expect.any(String),
      publicId: expect.stringMatching(/^mem_/),
      reflectionId: null,
      memoryPrId: null,
      createdAt: expect.any(Date),
    });
    expect(waiting[0]?.repos).toBeNull();
    expect(waiting[0]?.appliesTo).toBeNull();
    expect(waiting[0]?.tools).toBeNull();
  });

  it("marks the memories a new memory PR cites, so they stop waiting", async () => {
    const scope = newScope();
    await store.insertMemories(scope, [draft("First lesson.")]);
    await store.insertMemories(scope, [draft("Second lesson.")]);
    await store.insertMemories(scope, [draft("Third lesson.")]);
    const waiting = await store.listWaiting(scope);
    const records = [proposal("mem.first", waiting.slice(0, 2))];

    const prId = await store.insertMemoryPr(scope, pullRequest(7, records));

    expect(await store.countWaiting(scope)).toBe(1);
    expect((await store.listWaiting(scope)).map((m) => m.id)).toEqual(
      waiting.slice(2).map((m) => m.id),
    );
    expect(await store.listOpenPrs(scope)).toEqual([
      { id: prId, ...pullRequest(7, records), openedAt: expect.any(Date) },
    ]);
  });

  it("settles a memory PR: purges, rejects, and stamps recall rows", async () => {
    const scope = newScope();
    await store.insertMemories(scope, [draft("Merged lesson.")]);
    await store.insertMemories(scope, [draft("Rejected lesson.")]);
    await store.insertMemories(scope, [draft("Still waiting.")]);
    const [merged, rejected, left] = await store.listWaiting(scope);
    if (!merged || !rejected || !left)
      throw new Error("Expected three waiting memories.");
    const retire: MemoryPrRecord = {
      action: "retire",
      lineage: "mem.stale",
      path: "steering/memory/acme/general/mem.stale.md",
      kind: "memory",
      memoryIds: [],
      statementHashes: [],
    };
    const prId = await store.insertMemoryPr(
      scope,
      pullRequest(8, [
        proposal("mem.merged", [merged]),
        proposal("mem.rejected", [rejected]),
        retire,
      ]),
    );
    const settledAt = new Date("2026-09-20T12:00:00.000Z");

    await store.settlePr(scope, {
      prId,
      status: "merged",
      settledAt,
      mergedLineages: ["mem.merged"],
      reviewedLineages: ["mem.stale"],
      rejectedHashes: [rejected.statementHash, rejected.statementHash],
      purgeMemoryIds: [merged.id, rejected.id],
    });

    expect(await store.listOpenPrs(scope)).toEqual([]);
    const [row] = await withSystemDb((tx) =>
      tx
        .select({
          status: schema.memoryPullRequests.status,
          settledAt: schema.memoryPullRequests.settledAt,
        })
        .from(schema.memoryPullRequests)
        .where(eq(schema.memoryPullRequests.id, prId)),
    );
    expect(row).toEqual({ status: "merged", settledAt });
    expect((await store.listWaiting(scope)).map((m) => m.id)).toEqual([
      left.id,
    ]);
    expect(await store.deleteMemories(scope, [merged.id, rejected.id])).toBe(0);
    expect(await store.listRejections(scope)).toEqual([
      { statementHash: rejected.statementHash, rejectedAt: settledAt },
    ]);
    expect(await store.listRecalls(scope)).toEqual([
      {
        lineage: "mem.merged",
        recallCount: 0,
        lastRecalledAt: settledAt,
        reviewedAt: settledAt,
      },
      {
        lineage: "mem.stale",
        recallCount: 0,
        lastRecalledAt: settledAt,
        reviewedAt: settledAt,
      },
    ]);

    // A second settle of the same PR finds it closed and writes nothing.
    await store.settlePr(scope, {
      prId,
      status: "closed",
      settledAt: new Date("2026-09-21T12:00:00.000Z"),
      mergedLineages: [],
      reviewedLineages: ["mem.other"],
      rejectedHashes: [statementHash("Some other lesson.")],
      purgeMemoryIds: [left.id],
    });
    expect(await store.countWaiting(scope)).toBe(1);
    expect(await store.listRejections(scope)).toHaveLength(1);
    expect(await store.listRecalls(scope)).toHaveLength(2);

    // A later rejection of the same statement moves the rejection time. A
    // review of a recalled record resets both times and keeps its count.
    await store.bumpRecalls(
      scope,
      ["mem.merged"],
      new Date("2026-09-22T00:00:00.000Z"),
    );
    await store.insertMemories(scope, [draft("Rejected lesson.")]);
    const again = (await store.listWaiting(scope)).filter(
      (m) => m.statementHash === rejected.statementHash,
    );
    const laterPr = await store.insertMemoryPr(
      scope,
      pullRequest(9, [proposal("mem.rejected-again", again)]),
    );
    const later = new Date("2026-09-23T12:00:00.000Z");
    await store.settlePr(scope, {
      prId: laterPr,
      status: "closed",
      settledAt: later,
      mergedLineages: [],
      reviewedLineages: ["mem.merged"],
      rejectedHashes: [rejected.statementHash],
      purgeMemoryIds: again.map((m) => m.id),
    });
    expect(await store.listRejections(scope)).toEqual([
      { statementHash: rejected.statementHash, rejectedAt: later },
    ]);
    expect(await store.listRecalls(scope)).toContainEqual({
      lineage: "mem.merged",
      recallCount: 1,
      lastRecalledAt: later,
      reviewedAt: later,
    });
  });

  it("counts one recall of each lineage per call", async () => {
    const scope = newScope();
    const t1 = new Date("2026-09-01T00:00:00.000Z");
    const t2 = new Date("2026-09-02T00:00:00.000Z");
    await store.bumpRecalls(scope, ["mem.a", "mem.b", "mem.a"], t1);
    await store.bumpRecalls(scope, ["mem.a"], t2);
    expect(await store.listRecalls(scope)).toEqual([
      { lineage: "mem.a", recallCount: 2, lastRecalledAt: t2, reviewedAt: t1 },
      { lineage: "mem.b", recallCount: 1, lastRecalledAt: t1, reviewedAt: t1 },
    ]);
  });

  it("stamps both recall times and keeps the count", async () => {
    const scope = newScope();
    const t1 = new Date("2026-09-01T00:00:00.000Z");
    const t2 = new Date("2026-09-02T00:00:00.000Z");
    const t3 = new Date("2026-09-03T00:00:00.000Z");
    await store.bumpRecalls(scope, ["mem.a"], t1);
    await store.bumpRecalls(scope, ["mem.a"], t2);
    await store.stampRecalls(scope, ["mem.a", "mem.new", "mem.new"], t3);
    expect(await store.listRecalls(scope)).toEqual([
      { lineage: "mem.a", recallCount: 2, lastRecalledAt: t3, reviewedAt: t3 },
      {
        lineage: "mem.new",
        recallCount: 0,
        lastRecalledAt: t3,
        reviewedAt: t3,
      },
    ]);
  });

  it("lists the lessons of reflections written since a time", async () => {
    const scope = newScope();
    const run = runId();
    await store.insertReflection(
      scope,
      reflection(run, ["Check the plane before a cross-tenant read."]),
    );
    const minute = 60_000;
    expect(
      await store.listReflectionsSince(scope, new Date(Date.now() - minute)),
    ).toEqual([
      {
        createdAt: expect.any(Date),
        lessons: [{ statement: "Check the plane before a cross-tenant read." }],
      },
    ]);
    expect(
      await store.listReflectionsSince(scope, new Date(Date.now() + minute)),
    ).toEqual([]);
  });

  it("lists every workspace the curator has work in", async () => {
    const waiting = newScope();
    const openPr = newScope();
    const recalled = newScope();
    const idle = newScope();
    await store.insertMemories(waiting, [draft("A waiting lesson.")]);
    await store.insertMemoryPr(openPr, pullRequest(10, []));
    await store.bumpRecalls(recalled, ["mem.a"], new Date());
    await store.insertReflection(idle, reflection(runId(), ["An idle lesson."]));

    const scopes = await store.listCurateWorkspaces();

    expect(scopes).toEqual(expect.arrayContaining([waiting, openPr, recalled]));
    expect(scopes).not.toContainEqual(idle);
    const keys = scopes.map((s) => `${s.orgId}:${s.workspaceId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shows another workspace none of this workspace's rows", async () => {
    const scope = newScope();
    const other = newScope();
    const run = runId();
    await store.insertReflection(scope, reflection(run, ["A private lesson."]));
    await store.insertMemories(scope, [draft("A private memory.")]);
    await store.insertMemories(scope, [draft("A cited memory.")]);
    const waiting = await store.listWaiting(scope);
    const cited = waiting.slice(1);
    await store.insertMemoryPr(
      scope,
      pullRequest(11, [proposal("mem.cited", cited)]),
    );
    await store.bumpRecalls(scope, ["mem.private"], new Date());
    const ids = waiting.map((m) => m.id);

    expect(await store.countWaiting(other)).toBe(0);
    expect(await store.listWaiting(other)).toEqual([]);
    expect(await store.listOpenPrs(other)).toEqual([]);
    expect(await store.listRecalls(other)).toEqual([]);
    expect(await store.listRejections(other)).toEqual([]);
    expect(await store.hasReflection(other, run)).toBe(false);
    expect(await store.listReflectionsSince(other, new Date(0))).toEqual([]);
    expect(await store.deleteMemories(other, ids)).toBe(0);
    expect(await store.countWaiting(scope)).toBe(1);

    // The policy itself, not the store's WHERE, is what filters: an unfiltered
    // read as the application role (a superuser bypasses RLS) under the other
    // workspace's GUCs answers no row of this workspace, and under this
    // workspace's GUCs answers every one of them.
    const unfiltered = (workspace: string) =>
      withSystemDb(async (tx) => {
        await tx.execute(
          sql`select set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', ${orgId}, true), set_config('app.current_workspace_id', ${workspace}, true)`,
        );
        await tx.execute(sql`set local role oxagen_app`);
        const rows = await tx.execute(sql`select id from agent.memories`);
        return [...rows].map((r) => (r as { id: string }).id);
      });
    expect(await unfiltered(other.workspaceId)).toEqual([]);
    expect(new Set(await unfiltered(scope.workspaceId))).toEqual(new Set(ids));
  });
});
