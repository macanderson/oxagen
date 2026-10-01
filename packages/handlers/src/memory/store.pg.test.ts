// The Postgres memory store against a real migrated database (ADR-206): the
// one-reflection-per-run index, the dedupe key, the waiting queue, one
// waiting memory per memory file (ADR-238), a memory PR's life from open to
// settled, the uses and the lifecycle that keeps every row (ADR-245), the
// recall counters, the curator's cross-tenant listing, and the tenant
// policy on agent.memories. It runs
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
  MemoryUseDraft,
  ReflectionDraft,
  ReflectionLesson,
} from "./types";

const enabled = Boolean(process.env.DATABASE_URL);

const runId = () => `arun_${crypto.randomUUID().replace(/-/g, "")}`;

/** The agent every draft names, as a host's enrollment would. */
const AGENT = "agt.memory-store-test";

function draft(
  statement: string,
  over: Partial<MemoryDraft> = {},
): MemoryDraft {
  const runPublicId = runId();
  const hash = statementHash(statement);
  return {
    agentLineage: AGENT,
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

const FILE = "claude-code:/home/dev/.claude/projects/-proj/memory/use-pnpm.md";

/** The columns a new waiting memory starts with (ADR-245). */
const FRESH = {
  label: null,
  summary: null,
  memoryType: null,
  state: "waiting",
  useCount: 0,
  lastUsedAt: null,
  promotedLineage: null,
};

/** A memory file's statement, as ingest_tacho_memories stores it. */
function fileMemory(statement: string, source = FILE): MemoryDraft {
  return draft(statement, {
    runPublicId: null,
    capture: "local_gateway",
    evidence: [],
    source,
    dedupeKey: `local_gateway:${source}:${statementHash(statement)}`,
  });
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

  it("returns before any query when the id, lineage, or use list is empty", async () => {
    await expect(store.insertMemories(bogus, [])).resolves.toBe(0);
    await expect(store.recordUses(bogus, [])).resolves.toEqual({
      recorded: 0,
      unknown: 0,
    });
    await expect(store.linkMemories(bogus, [])).resolves.toBe(0);
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

  /** Every row of the workspace's, oldest first, with its lifecycle columns. */
  const rowsOf = (scope: MemoryScope) =>
    withSystemDb((tx) =>
      tx
        .select({
          id: schema.memories.id,
          statement: schema.memories.statement,
          memoryPrId: schema.memories.memoryPrId,
          state: schema.memories.state,
          retiredAt: schema.memories.retiredAt,
          retiredReason: schema.memories.retiredReason,
          promotedLineage: schema.memories.promotedLineage,
          useCount: schema.memories.useCount,
          lastUsedAt: schema.memories.lastUsedAt,
        })
        .from(schema.memories)
        .where(eq(schema.memories.workspaceId, scope.workspaceId))
        .orderBy(schema.memories.createdAt, schema.memories.id),
    );

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

  it("stores a reflection and its lessons in one transaction", async () => {
    const scope = newScope();
    const run = runId();
    const id = await store.insertReflection(
      scope,
      reflection(run, ["Run the migration check first."]),
      [draft("Run the migration check first.")],
    );
    expect(id).toEqual(expect.any(String));
    expect(
      (await store.listWaiting(scope)).map((m) => m.reflectionId),
    ).toEqual([id]);
    // A second reflection for the run writes neither it nor its lessons.
    expect(
      await store.insertReflection(scope, reflection(run, ["Another lesson."]), [
        draft("Another lesson."),
      ]),
    ).toBeNull();
    expect(await store.countWaiting(scope)).toBe(1);
  });

  it("stores no reflection when the database refuses one of its lessons", async () => {
    const scope = newScope();
    const run = runId();
    // memories_statement_check refuses an empty statement.
    await expect(
      store.insertReflection(scope, reflection(run, ["A lesson."]), [
        draft("A lesson."),
        draft("A refused lesson.", { statement: "" }),
      ]),
    ).rejects.toThrow();
    expect(await store.hasReflection(scope, run)).toBe(false);
    expect(await store.countWaiting(scope)).toBe(0);
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

    // The first call cited the reflection, so both of its rows carry it. The
    // later calls cited none, and the kept row keeps the id it was written with.
    const waiting = await store.listWaiting(scope);
    const reflectionOf = new Map(
      waiting.map((m) => [m.statement, m.reflectionId]),
    );
    expect(Object.fromEntries(reflectionOf)).toEqual({
      "Prefer rg over grep.": reflectionId,
      "Pin the lockfile.": reflectionId,
      "Write the test first.": null,
      "Read the failing step first.": null,
    });
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
      ...FRESH,
      id: expect.any(String),
      publicId: expect.stringMatching(/^mem_/),
      reflectionId: null,
      memoryPrId: null,
      createdAt: expect.any(Date),
    });
    expect(waiting[1]).toEqual({
      ...second,
      ...FRESH,
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

  describe("one waiting memory per memory file", () => {

    /** Cite every waiting memory in a new open memory PR. */
    async function citeWaiting(scope: MemoryScope, number: number) {
      const waiting = await store.listWaiting(scope);
      await store.insertMemoryPr(
        scope,
        pullRequest(number, [proposal("mem.use-pnpm", waiting)]),
      );
    }

    it("replaces the waiting memory's text in place when the file changes", async () => {
      const scope = newScope();
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
      ).toBe(true);
      const [before] = await store.listWaiting(scope);
      const edited = fileMemory("Use pnpm, never npm.");
      expect(await store.replaceSourceMemory(scope, edited)).toBe(true);
      const waiting = await store.listWaiting(scope);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toEqual({
        ...edited,
        ...FRESH,
        id: before?.id,
        publicId: before?.publicId,
        reflectionId: null,
        memoryPrId: null,
        createdAt: before?.createdAt,
      });
    });

    it("stores nothing for the text the waiting memory already holds", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
      ).toBe(false);
      expect(await store.countWaiting(scope)).toBe(1);
    });

    it("keeps the text an open memory PR cites and adds the new text as a waiting memory", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      await citeWaiting(scope, 21);
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm, never npm.")),
      ).toBe(true);
      const rows = await rowsOf(scope);
      expect(rows.map((row) => [row.statement, row.memoryPrId !== null])).toEqual([
        ["Use pnpm.", true],
        ["Use pnpm, never npm.", false],
      ]);
    });

    it("retires the waiting memory when the file goes back to the text a memory PR cites", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      await citeWaiting(scope, 22);
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm, never npm."));
      // An update to the cited row's dedupe key would break memories_dedupe_uq.
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
      ).toBe(false);
      expect(await store.countWaiting(scope)).toBe(0);
      expect(
        (await rowsOf(scope)).map((row) => [
          row.statement,
          row.state,
          row.retiredReason,
        ]),
      ).toEqual([
        ["Use pnpm.", "in_pr", null],
        ["Use pnpm, never npm.", "retired", "deleted"],
      ]);
    });

    it("brings back a memory retired as deleted when its file holds the text again", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      await store.retireMissingSources(
        scope,
        { capture: "local_gateway", prefix: "claude-code:/home/dev/", seen: [], agentLineage: AGENT },
        new Date(),
      );
      expect(await store.countWaiting(scope)).toBe(0);
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
      ).toBe(true);
      expect((await rowsOf(scope)).map((row) => [row.state, row.retiredAt])).toEqual([
        ["waiting", null],
      ]);
    });

    it("keeps a memory retired as unused when a restarted daemon sends its file again", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      await store.retireUnused(scope, new Date(Date.now() + 60_000), new Date());
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
      ).toBe(false);
      expect((await rowsOf(scope)).map((row) => [row.state, row.retiredReason])).toEqual([
        ["retired", "unused"],
      ]);
    });

    it("keeps a file's frontmatter, and updates it when only the frontmatter changes", async () => {
      const scope = newScope();
      await store.replaceSourceMemory(scope, {
        ...fileMemory("Use pnpm."),
        label: "pnpm",
        memoryType: "feedback",
      });
      expect(
        await store.replaceSourceMemory(scope, {
          ...fileMemory("Use pnpm."),
          label: "Package manager",
          summary: "Which package manager to run.",
          memoryType: "project",
        }),
      ).toBe(false);
      expect((await store.listWaiting(scope))[0]).toMatchObject({
        label: "Package manager",
        summary: "Which package manager to run.",
        memoryType: "project",
      });
    });

    it("keeps the oldest of the waiting rows a file held before and retires the rest", async () => {
      const scope = newScope();
      // Two rows from one file, as ingest wrote them before ADR-238.
      await store.insertMemories(scope, [fileMemory("Use pnpm.")]);
      await store.insertMemories(scope, [fileMemory("Use pnpm 9.")]);
      const [oldest] = await store.listWaiting(scope);
      expect(
        await store.replaceSourceMemory(scope, fileMemory("Use pnpm 10.")),
      ).toBe(true);
      const waiting = await store.listWaiting(scope);
      expect(waiting.map((m) => [m.id, m.statement])).toEqual([
        [oldest?.id, "Use pnpm 10."],
      ]);
      expect((await rowsOf(scope)).map((row) => row.state)).toEqual([
        "waiting",
        "retired",
      ]);
    });

    it("keeps one waiting memory when two sends from one file land at once", async () => {
      const scope = newScope();
      const answers = await Promise.all([
        store.replaceSourceMemory(scope, fileMemory("Use pnpm.")),
        store.replaceSourceMemory(scope, fileMemory("Use pnpm, never npm.")),
      ]);
      expect(answers).toEqual([true, true]);
      expect(await store.countWaiting(scope)).toBe(1);
    });

    it("keeps a waiting memory for each file", async () => {
      const scope = newScope();
      const other = "claude-code:/home/dev/.claude/projects/-proj/memory/deploy.md";
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm.", other));
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm 10."));
      const waiting = await store.listWaiting(scope);
      expect(waiting.map((m) => [m.source, m.statement])).toEqual([
        [FILE, "Use pnpm 10."],
        [other, "Use pnpm."],
      ]);
    });
  });

  describe("memory uses and the lifecycle (ADR-245)", () => {
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 9, 1, 12, minutes));

    /** A read of the file `source` holds, by `run`. */
    const read = (
      run: string,
      usedAt: Date,
      over: Partial<MemoryUseDraft> = {},
    ): MemoryUseDraft => ({
      capture: "local_gateway",
      source: FILE,
      runPublicId: run,
      signal: "read",
      count: 1,
      usedAt,
      ...over,
    });

    /** The uses table's rows for one memory. */
    const usesOf = (memoryId: string) =>
      withSystemDb((tx) =>
        tx
          .select({
            runPublicId: schema.memoryUses.runPublicId,
            signal: schema.memoryUses.signal,
            count: schema.memoryUses.count,
            usedAt: schema.memoryUses.usedAt,
          })
          .from(schema.memoryUses)
          .where(eq(schema.memoryUses.memoryId, memoryId))
          .orderBy(schema.memoryUses.usedAt),
      );

    /** use_count and last_used_at as the uses table computes them. */
    const fromUsesTable = async (memoryId: string) => {
      const rows = await withSystemDb((tx) =>
        tx.execute(
          sql`select (count(distinct run_public_id) + coalesce(sum(count) filter (where run_public_id is null), 0))::int as uses, max(used_at) as last from agent.memory_uses where memory_id = ${memoryId}`,
        ),
      );
      const [row] = [...rows] as Array<{ uses: number; last: Date | string | null }>;
      const last = row?.last ?? null;
      return {
        useCount: row?.uses ?? 0,
        lastUsedAt: last === null ? null : new Date(last),
      };
    };

    async function fileMemoryIn(scope: MemoryScope, statement = "Use pnpm.") {
      await store.replaceSourceMemory(scope, fileMemory(statement));
      const [row] = await rowsOf(scope);
      if (row === undefined) throw new Error("expected a memory row");
      return row;
    }

    it("adds one use for a run that reads a memory file twice", async () => {
      const scope = newScope();
      const memory = await fileMemoryIn(scope);
      const run = runId();
      // Twice in one report, and again in a later one.
      expect(
        await store.recordUses(scope, [read(run, at(1)), read(run, at(2))]),
      ).toEqual({ recorded: 2, unknown: 0 });
      await store.recordUses(scope, [read(run, at(3))]);
      expect(await usesOf(memory.id)).toEqual([
        { runPublicId: run, signal: "read", count: 3, usedAt: at(3) },
      ]);
      expect((await rowsOf(scope))[0]).toMatchObject({
        useCount: 1,
        lastUsedAt: at(3),
      });
    });

    it("keeps use_count and last_used_at equal to the uses table", async () => {
      const scope = newScope();
      const memory = await fileMemoryIn(scope);
      const [a, b] = [runId(), runId()];
      await store.recordUses(scope, [
        read(a, at(5)),
        // A run that reads and cites a memory is still one run.
        read(a, at(6), { signal: "citation" }),
        read(b, at(4)),
        // A harness's own count with no run counts as reported.
        read("", at(2), { runPublicId: null, signal: "harness_count", count: 3 }),
      ]);
      await store.recordUses(scope, [
        read("", at(9), { runPublicId: null, signal: "harness_count", count: 2 }),
      ]);
      const [row] = await rowsOf(scope);
      expect(row?.useCount).toBe(2 + 3 + 2);
      expect(row?.lastUsedAt).toEqual(at(9));
      expect({ useCount: row?.useCount, lastUsedAt: row?.lastUsedAt }).toEqual(
        await fromUsesTable(memory.id),
      );
    });

    it("counts both uses when two reports for one memory land at once", async () => {
      const scope = newScope();
      const memory = await fileMemoryIn(scope);
      await Promise.all([
        store.recordUses(scope, [read(runId(), at(1))]),
        store.recordUses(scope, [read(runId(), at(2))]),
      ]);
      expect((await rowsOf(scope))[0]?.useCount).toBe(2);
      expect((await fromUsesTable(memory.id)).useCount).toBe(2);
    });

    it("answers a use of a file that holds no memory as unknown", async () => {
      const scope = newScope();
      await fileMemoryIn(scope);
      expect(
        await store.recordUses(scope, [
          read(runId(), at(1), { source: `${FILE}.missing` }),
          read(runId(), at(1)),
        ]),
      ).toEqual({ recorded: 1, unknown: 1 });
    });

    it("credits a use to the file's waiting memory over the one a memory PR cites", async () => {
      const scope = newScope();
      await fileMemoryIn(scope, "Use pnpm.");
      const cited = await store.listWaiting(scope);
      await store.insertMemoryPr(
        scope,
        pullRequest(31, [proposal("mem.use-pnpm", cited)]),
      );
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm 10."));
      await store.recordUses(scope, [read(runId(), at(1))]);
      expect(
        (await rowsOf(scope)).map((row) => [row.statement, row.state, row.useCount]),
      ).toEqual([
        ["Use pnpm.", "in_pr", 0],
        ["Use pnpm 10.", "waiting", 1],
      ]);
    });

    it("keeps a promoted memory's row and count, and keeps counting its uses", async () => {
      const scope = newScope();
      const memory = await fileMemoryIn(scope);
      await store.recordUses(scope, [read(runId(), at(1)), read(runId(), at(2))]);
      const prId = await store.insertMemoryPr(
        scope,
        pullRequest(32, [proposal("mem.use-pnpm", await store.listWaiting(scope))]),
      );
      await store.settlePr(scope, {
        prId,
        status: "merged",
        settledAt: at(3),
        mergedLineages: ["mem.use-pnpm"],
        reviewedLineages: [],
        rejectedHashes: [],
        promoted: [{ lineage: "mem.use-pnpm", memoryIds: [memory.id] }],
        returnedMemoryIds: [],
      });
      expect((await rowsOf(scope))[0]).toMatchObject({
        id: memory.id,
        state: "promoted",
        promotedLineage: "mem.use-pnpm",
        useCount: 2,
      });
      await store.recordUses(scope, [read(runId(), at(4))]);
      expect((await rowsOf(scope))[0]).toMatchObject({
        state: "promoted",
        useCount: 3,
        lastUsedAt: at(4),
      });
    });

    it("keeps a dismissed memory's row and count, which no scan or age retires", async () => {
      const scope = newScope();
      const memory = await fileMemoryIn(scope);
      await store.recordUses(scope, [read(runId(), at(1))]);
      // MEM5 builds dismiss_memories. The row is set the way it will set it.
      await withSystemDb((tx) =>
        tx
          .update(schema.memories)
          .set({ state: "dismissed" })
          .where(eq(schema.memories.id, memory.id)),
      );
      expect(
        await store.retireMissingSources(
          scope,
          { capture: "local_gateway", prefix: "claude-code:/home/dev/", seen: [], agentLineage: AGENT },
          at(2),
        ),
      ).toBe(0);
      expect(
        await store.retireUnused(scope, new Date(Date.now() + 60_000), at(2)),
      ).toBe(0);
      await store.recordUses(scope, [read(runId(), at(3))]);
      expect((await rowsOf(scope))[0]).toMatchObject({
        state: "dismissed",
        useCount: 2,
      });
    });

    it("retires the memories of files a full scan no longer finds, for the scan's folder and agent only", async () => {
      const scope = newScope();
      const root = "claude-code:/home/dev/.claude/projects/";
      const kept = `${root}-proj/memory/kept.md`;
      const gone = `${root}-proj/memory/gone.md`;
      const promotedGone = `${root}-proj/memory/promoted.md`;
      const elsewhere = "claude-code:/home/other/.claude/projects/-proj/memory/gone.md";
      const otherAgent = `${root}-proj/memory/other-agent.md`;
      for (const source of [kept, gone, promotedGone, elsewhere])
        await store.replaceSourceMemory(scope, fileMemory(`From ${source}.`, source));
      await store.replaceSourceMemory(scope, {
        ...fileMemory(`From ${otherAgent}.`, otherAgent),
        agentLineage: "agt.someone-else",
      });
      const promoted = (await store.listWaiting(scope)).find(
        (m) => m.source === promotedGone,
      );
      if (promoted === undefined) throw new Error("expected the promoted memory");
      await store.linkMemories(scope, [{ memoryId: promoted.id, lineage: "mem.x" }]);

      expect(
        await store.retireMissingSources(
          scope,
          { capture: "local_gateway", prefix: root, seen: [kept], agentLineage: AGENT },
          at(5),
        ),
      ).toBe(2);
      const states = Object.fromEntries(
        (await rowsOf(scope)).map((row) => [row.statement, [row.state, row.retiredReason]]),
      );
      expect(states).toEqual({
        [`From ${kept}.`]: ["waiting", null],
        [`From ${gone}.`]: ["retired", "deleted"],
        [`From ${promotedGone}.`]: ["retired", "deleted"],
        [`From ${elsewhere}.`]: ["waiting", null],
        [`From ${otherAgent}.`]: ["waiting", null],
      });

      // The file comes back with its text, and so does its memory. The
      // promoted one comes back promoted.
      expect(
        await store.replaceSourceMemory(scope, fileMemory(`From ${gone}.`, gone)),
      ).toBe(true);
      expect(
        await store.replaceSourceMemory(
          scope,
          fileMemory(`From ${promotedGone}.`, promotedGone),
        ),
      ).toBe(true);
      const back = Object.fromEntries(
        (await rowsOf(scope)).map((row) => [row.statement, row.state]),
      );
      expect(back[`From ${gone}.`]).toBe("waiting");
      expect(back[`From ${promotedGone}.`]).toBe("promoted");
    });

    it("retires a memory no run used within the window, counting from its newest use", async () => {
      const scope = newScope();
      await store.insertMemories(scope, [draft("Never used.")]);
      await store.replaceSourceMemory(scope, fileMemory("Used lately."));
      await store.recordUses(scope, [read(runId(), new Date(Date.now() + 120_000))]);
      const cutoff = new Date(Date.now() + 60_000);
      // Every row was captured before the cutoff, but one was used after it.
      expect(await store.retireUnused(scope, cutoff, new Date())).toBe(1);
      expect(
        (await rowsOf(scope)).map((row) => [row.statement, row.state, row.retiredReason]),
      ).toEqual([
        ["Never used.", "retired", "unused"],
        ["Used lately.", "waiting", null],
      ]);
    });

    it("brings back a retired memory that a run uses", async () => {
      const scope = newScope();
      await fileMemoryIn(scope);
      await store.retireUnused(scope, new Date(Date.now() + 60_000), at(1));
      expect((await rowsOf(scope))[0]?.state).toBe("retired");
      await store.recordUses(scope, [read(runId(), at(2))]);
      expect((await rowsOf(scope))[0]).toMatchObject({
        state: "waiting",
        retiredAt: null,
        retiredReason: null,
        useCount: 1,
      });
    });

    it("links a waiting memory to the record that already says it", async () => {
      const scope = newScope();
      await store.insertMemories(scope, [draft("Said already.")]);
      const [memory] = await store.listWaiting(scope);
      if (memory === undefined) throw new Error("expected a memory");
      expect(
        await store.linkMemories(scope, [
          { memoryId: memory.id, lineage: "mem.said" },
          { memoryId: memory.id, lineage: "mem.said" },
        ]),
      ).toBe(1);
      expect((await rowsOf(scope))[0]).toMatchObject({
        state: "promoted",
        promotedLineage: "mem.said",
      });
      expect(await store.countWaiting(scope)).toBe(0);
    });

    it("retires a returned file memory whose file moved on while its PR was open", async () => {
      const scope = newScope();
      await fileMemoryIn(scope, "Use pnpm.");
      const cited = await store.listWaiting(scope);
      const prId = await store.insertMemoryPr(
        scope,
        pullRequest(33, [proposal("mem.use-pnpm", cited)]),
      );
      await store.replaceSourceMemory(scope, fileMemory("Use pnpm 10."));
      await store.settlePr(scope, {
        prId,
        status: "closed",
        settledAt: at(7),
        mergedLineages: [],
        reviewedLineages: [],
        rejectedHashes: cited.map((m) => m.statementHash),
        promoted: [],
        returnedMemoryIds: cited.map((m) => m.id),
      });
      expect(
        (await rowsOf(scope)).map((row) => [row.statement, row.state, row.retiredAt]),
      ).toEqual([
        ["Use pnpm.", "retired", at(7)],
        ["Use pnpm 10.", "waiting", null],
      ]);
    });
  });

  it("knows the branches a workspace opened a memory PR from, settled or not", async () => {
    const scope = newScope();
    const other = newScope();
    const prId = await store.insertMemoryPr(scope, pullRequest(9, []));

    expect(await store.openedPrFrom(scope, "memory/2026-09-09")).toBe(true);
    expect(await store.openedPrFrom(scope, "memory/2026-09-10")).toBe(false);
    expect(await store.openedPrFrom(other, "memory/2026-09-09")).toBe(false);

    await store.settlePr(scope, {
      prId,
      status: "closed",
      settledAt: new Date(),
      mergedLineages: [],
      reviewedLineages: [],
      rejectedHashes: [],
      promoted: [],
      returnedMemoryIds: [],
    });
    expect(await store.openedPrFrom(scope, "memory/2026-09-09")).toBe(true);
  });

  it("settles a memory PR: promotes, returns, rejects, and stamps recall rows", async () => {
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
      promoted: [{ lineage: "mem.merged", memoryIds: [merged.id] }],
      returnedMemoryIds: [rejected.id],
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
    // No memory is deleted (ADR-245). The merged record's memory is promoted
    // and names its PR, and the rejected record's memory waits again.
    expect(
      (await rowsOf(scope)).map((r) => [r.id, r.state, r.promotedLineage, r.memoryPrId]),
    ).toEqual([
      [merged.id, "promoted", "mem.merged", prId],
      [rejected.id, "waiting", null, prId],
      [left.id, "waiting", null, null],
    ]);
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
      promoted: [{ lineage: "mem.other", memoryIds: [left.id] }],
      returnedMemoryIds: [],
    });
    expect(await store.countWaiting(scope)).toBe(2);
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
      promoted: [],
      returnedMemoryIds: again.map((m) => m.id),
    });
    expect(again).toHaveLength(2);
    expect(await store.countWaiting(scope)).toBe(3);
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
    expect(
      await store.linkMemories(
        other,
        ids.map((memoryId) => ({ memoryId, lineage: "mem.other" })),
      ),
    ).toBe(0);
    expect(
      await store.retireUnused(other, new Date(Date.now() + 60_000), new Date()),
    ).toBe(0);
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

  it("shows another workspace none of this workspace's memory uses", async () => {
    const scope = newScope();
    const other = newScope();
    await store.replaceSourceMemory(scope, fileMemory("Use pnpm."));
    const use: MemoryUseDraft = {
      capture: "local_gateway",
      source: FILE,
      runPublicId: runId(),
      signal: "read",
      count: 1,
      usedAt: new Date(),
    };
    // The other workspace holds no memory for the file, so its use is unknown.
    expect(await store.recordUses(other, [use])).toEqual({
      recorded: 0,
      unknown: 1,
    });
    expect(await store.recordUses(scope, [use])).toEqual({
      recorded: 1,
      unknown: 0,
    });
    const unfiltered = (workspace: string) =>
      withSystemDb(async (tx) => {
        await tx.execute(
          sql`select set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', ${orgId}, true), set_config('app.current_workspace_id', ${workspace}, true)`,
        );
        await tx.execute(sql`set local role oxagen_app`);
        const rows = await tx.execute(sql`select id from agent.memory_uses`);
        return [...rows].length;
      });
    expect(await unfiltered(other.workspaceId)).toBe(0);
    expect(await unfiltered(scope.workspaceId)).toBe(1);
  });
});
