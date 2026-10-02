import { describe, expect, it } from "vitest";
import type { RecordKind } from "@oxagen/oxagen/steering-repo/record";
import {
  MEMORY_PR_FILES_MAX,
  memoryBranch,
  memoryPrBody,
  memoryPrTitle,
  planCuration,
  rankMemories,
} from "./curate";
import { statementHash } from "./statement";
import type {
  ActiveRecord,
  CurateInput,
  CuratePlan,
  MemoryPrRecord,
  PlannedRecord,
  RecallStamp,
  StoredMemory,
} from "./types";

const NOW = new Date("2026-09-26T12:00:00Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Its words are run, migration, generator, schema, and edit. */
const MIGRATE = "Run the migration generator after a schema edit";
/** The same words in other grammar, so a different hash. */
const MIGRATE_AGAIN = "Always run the migration generator after schema edits";
/** The same words, turned around. */
const NEVER_MIGRATE = "Never run the migration generator after a schema edit";
const REFUND = "Billing refunds need an idempotency key";
const KEYS = "Rotate the signing keys monthly";
const PNPM = "Pin the pnpm version in CI";
const CHANGELOG = "Keep the changelog short";

const BASE_LINEAGE = "run-migration-generator-after-schema-edit";

/**
 * A waiting memory. Unless a test sets its uses, an older memory has more:
 * one per minute of age. The ranking then reads oldest first, so a test
 * about grouping or the batch can state its order by `createdAt` alone.
 */
function memory(id: string, overrides: Partial<StoredMemory> = {}): StoredMemory {
  const statement = overrides.statement ?? MIGRATE;
  const createdAt = overrides.createdAt ?? daysAgo(1);
  return {
    id,
    publicId: `mem_${id}`,
    reflectionId: null,
    memoryPrId: null,
    agentLineage: "claude-code",
    runPublicId: `arun_${id}`,
    capture: "remember",
    statement,
    statementHash: statementHash(statement),
    kind: "procedure",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [`frame:arun_${id}/1`],
    source: null,
    dedupeKey: `arun_${id}:${statementHash(statement)}`,
    state: "waiting",
    useCount: Math.max(1, Math.round((NOW.getTime() - createdAt.getTime()) / 60_000)),
    lastUsedAt: null,
    promotedLineage: null,
    createdAt,
    ...overrides,
  };
}

function activeRecord(
  lineage: string,
  overrides: Partial<ActiveRecord> = {},
): ActiveRecord {
  return {
    path: `steering/memory/workspace/general/${lineage}.md`,
    lineage,
    kind: "memory",
    status: "active",
    force: "info",
    statement: CHANGELOG,
    repos: null,
    appliesTo: null,
    tools: null,
    text: `---\nlineage: ${lineage}\n---\n`,
    ...overrides,
  };
}

function pendingRecord(
  action: MemoryPrRecord["action"],
  lineage: string,
  statementHashes: string[] = [],
): MemoryPrRecord {
  return {
    action,
    lineage,
    path: `steering/memory/workspace/general/${lineage}.md`,
    kind: "memory",
    memoryIds: [],
    statementHashes,
  };
}

function stamp(
  lineage: string,
  lastRecalledAt: Date,
  reviewedAt: Date = lastRecalledAt,
): RecallStamp {
  return { lineage, recallCount: 1, lastRecalledAt, reviewedAt };
}

function input(overrides: Partial<CurateInput> = {}): CurateInput {
  return {
    now: NOW,
    governance: { batch_size: 20, retire_after_days: 180 },
    waiting: [],
    records: [],
    pending: [],
    rejections: [],
    recalls: [],
    reflections: [],
    runUri: (run) => `https://app.oxagen.ai/runs/${run}`,
    ...overrides,
  };
}

function cited(plan: CuratePlan): string[][] {
  return plan.records.map((record) => record.memoryIds);
}

describe("planCuration", () => {
  it("plans nothing for an empty workspace", () => {
    expect(planCuration(input())).toEqual({
      said: [],
      held: [],
      unused: [],
      deferred: [],
      records: [],
      retirements: [],
      queuedRetirements: [],
      stampRecalls: [],
    });
  });

  describe("retirements", () => {
    it("archives a contradicted or stale memory record, and stamps one with no recall row", () => {
      const contradicted = activeRecord("contradicted", { statement: MIGRATE });
      const both = activeRecord("both", { statement: MIGRATE });
      const reviewedLater = activeRecord("reviewed-later", { statement: MIGRATE });
      const stale = activeRecord("stale", { statement: REFUND });
      const fresh = activeRecord("fresh", { statement: KEYS });
      const unstamped = activeRecord("unstamped", { statement: PNPM });
      const plan = planCuration(
        input({
          records: [
            contradicted,
            both,
            reviewedLater,
            stale,
            fresh,
            unstamped,
            activeRecord("rule", {
              path: "steering/code-rules/rule.md",
              kind: "code-rule",
              statement: MIGRATE,
            }),
            activeRecord("archived", { status: "archived", statement: MIGRATE }),
            activeRecord("proposed", { statement: MIGRATE }),
            activeRecord("retiring", { statement: MIGRATE }),
          ],
          pending: [
            pendingRecord("propose", "proposed", ["h1"]),
            pendingRecord("retire", "retiring"),
          ],
          recalls: [
            stamp("contradicted", daysAgo(1), daysAgo(10)),
            stamp("both", daysAgo(200), daysAgo(10)),
            stamp("reviewed-later", daysAgo(1), daysAgo(3)),
            stamp("stale", daysAgo(181)),
            // Exactly 180 days is not more than 180 days.
            stamp("fresh", daysAgo(180)),
            stamp("rule", daysAgo(200)),
            stamp("archived", daysAgo(200)),
            stamp("proposed", daysAgo(200)),
            stamp("retiring", daysAgo(200)),
          ],
          reflections: [
            {
              createdAt: daysAgo(5),
              lessons: [{ statement: CHANGELOG }, { statement: NEVER_MIGRATE }],
            },
            { createdAt: daysAgo(1), lessons: [{ statement: PNPM }] },
          ],
        }),
      );
      expect(plan.retirements).toEqual([
        {
          path: contradicted.path,
          lineage: "contradicted",
          kind: "memory",
          reason: "contradicted",
          text: contradicted.text,
        },
        {
          path: both.path,
          lineage: "both",
          kind: "memory",
          reason: "contradicted",
          text: both.text,
        },
        {
          path: stale.path,
          lineage: "stale",
          kind: "memory",
          reason: "stale",
          text: stale.text,
        },
      ]);
      expect(plan.stampRecalls).toEqual([unstamped.lineage]);
    });

    it("never archives a must or should record under steering/memory, which loads on every request", () => {
      const plan = planCuration(
        input({
          records: [
            activeRecord("must-stale", { kind: "code-rule", force: "must", statement: REFUND }),
            activeRecord("should-contradicted", {
              kind: "business-rule",
              force: "should",
              statement: MIGRATE,
            }),
            activeRecord("must-unstamped", { kind: "code-rule", force: "must", statement: PNPM }),
            activeRecord("may-stale", { kind: "preference", force: "may", statement: KEYS }),
          ],
          recalls: [
            stamp("must-stale", daysAgo(400)),
            stamp("should-contradicted", daysAgo(1), daysAgo(10)),
            stamp("may-stale", daysAgo(181)),
          ],
          reflections: [{ createdAt: daysAgo(5), lessons: [{ statement: NEVER_MIGRATE }] }],
        }),
      );
      expect(plan.retirements.map((r) => [r.lineage, r.reason])).toEqual([
        ["may-stale", "stale"],
      ]);
      // A must record gets no recall row either, so no stale clock starts.
      expect(plan.stampRecalls).toEqual([]);
    });
  });

  describe("links", () => {
    it("links a memory an active record already says to that record, whatever the record's kind", () => {
      const plan = planCuration(
        input({
          waiting: [
            memory("said", { statement: MIGRATE_AGAIN }),
            memory("archived-says", { statement: CHANGELOG }),
            memory("new", { statement: KEYS }),
          ],
          records: [
            activeRecord("rule", {
              path: "steering/code-rules/rule.md",
              kind: "code-rule",
              statement: MIGRATE,
            }),
            activeRecord("old", { status: "archived", statement: CHANGELOG }),
          ],
        }),
      );
      expect(plan.said).toEqual([{ memoryId: "said", lineage: "rule" }]);
      expect(cited(plan)).toEqual([["archived-says"], ["new"]]);
      expect(plan.stampRecalls).toEqual([]);
    });

    it("leaves age to the store: a memory past retire_after_days is still planned", () => {
      // The runner retires a memory no run used for retire_after_days before
      // it plans (ADR-245), so a memory the plan reads is one to keep.
      const plan = planCuration(
        input({
          waiting: [
            memory("old", {
              statement: REFUND,
              createdAt: daysAgo(400),
              useCount: 3,
              lastUsedAt: daysAgo(2),
            }),
          ],
        }),
      );
      expect(plan.said).toEqual([]);
      expect(cited(plan)).toEqual([["old"]]);
    });
  });

  describe("ranking", () => {
    it("ranks by uses, then the newest use, then the newest capture", () => {
      const ranked = rankMemories([
        memory("few", { useCount: 1, lastUsedAt: daysAgo(1), createdAt: daysAgo(1) }),
        memory("many-old-use", { useCount: 5, lastUsedAt: daysAgo(9), createdAt: daysAgo(10) }),
        memory("many-new-use", { useCount: 5, lastUsedAt: daysAgo(2), createdAt: daysAgo(20) }),
        memory("tie-older", { useCount: 2, lastUsedAt: daysAgo(3), createdAt: daysAgo(8) }),
        memory("tie-newer", { useCount: 2, lastUsedAt: daysAgo(3), createdAt: daysAgo(4) }),
        memory("tie-b", { useCount: 2, lastUsedAt: daysAgo(3), createdAt: daysAgo(4) }),
      ]);
      expect(ranked.map((m) => m.id)).toEqual([
        "many-new-use",
        "many-old-use",
        "tie-b",
        "tie-newer",
        "tie-older",
        "few",
      ]);
    });

    it("fills the batch from the top of the ranking, and leaves every memory no run used waiting", () => {
      const plan = planCuration(
        input({
          governance: { batch_size: 2, retire_after_days: 180 },
          waiting: [
            memory("unused-a", { statement: PNPM, useCount: 0, createdAt: daysAgo(30) }),
            memory("low", { statement: KEYS, useCount: 1, lastUsedAt: daysAgo(1) }),
            memory("top", { statement: REFUND, useCount: 9, lastUsedAt: daysAgo(5) }),
            memory("middle", { statement: MIGRATE, useCount: 4, lastUsedAt: daysAgo(1) }),
            memory("unused-b", { statement: CHANGELOG, useCount: 0 }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["top"], ["middle"]]);
      expect(plan.deferred).toEqual(["low"]);
      expect(plan.unused).toEqual(["unused-a", "unused-b"]);
      for (const record of plan.records)
        for (const id of record.memoryIds)
          expect(["unused-a", "unused-b"]).not.toContain(id);
    });

    it("lets the highest ranked memory of a group speak for it, and orders the group by rank", () => {
      const plan = planCuration(
        input({
          waiting: [
            memory("older", { useCount: 1, createdAt: daysAgo(9) }),
            memory("used-most", {
              statement: MIGRATE_AGAIN,
              useCount: 7,
              createdAt: daysAgo(2),
            }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["used-most", "older"]]);
      expect(plan.records[0]?.draft.statement).toBe(MIGRATE_AGAIN);
    });

    it("holds a used memory a rejection still holds, and does not count it as unused", () => {
      const plan = planCuration(
        input({
          waiting: [memory("rejected", { useCount: 4, createdAt: daysAgo(9) })],
          rejections: [
            { statementHash: statementHash(MIGRATE), rejectedAt: daysAgo(5) },
          ],
        }),
      );
      expect(plan.held).toEqual(["rejected"]);
      expect(plan.unused).toEqual([]);
      expect(plan.records).toEqual([]);
    });
  });

  describe("holds", () => {
    it("holds a memory whose statement an open memory PR already proposes", () => {
      const plan = planCuration(
        input({
          waiting: [memory("proposed"), memory("new", { statement: REFUND })],
          pending: [
            pendingRecord("propose", "earlier", [statementHash(MIGRATE)]),
            // A retirement proposes nothing, so its hashes hold no memory.
            pendingRecord("retire", "retiring", [statementHash(REFUND)]),
          ],
        }),
      );
      expect(plan.held).toEqual(["proposed"]);
      expect(cited(plan)).toEqual([["new"]]);
    });

    it("holds a rejected statement until memories from 2 runs repeat it after the rejection", () => {
      const rejections = [
        { statementHash: statementHash(MIGRATE), rejectedAt: daysAgo(5) },
        { statementHash: statementHash(REFUND), rejectedAt: daysAgo(8) },
      ];
      const before = memory("before", { createdAt: daysAgo(6) });
      const once = memory("once", { runPublicId: "arun_x", createdAt: daysAgo(3) });
      const twice = memory("twice", { runPublicId: "arun_x", createdAt: daysAgo(2) });
      const onlyOld = memory("only-old", { statement: REFUND, createdAt: daysAgo(9) });

      const oneRun = planCuration(
        input({ waiting: [before, once, twice, onlyOld], rejections }),
      );
      expect(oneRun.held).toEqual(["before", "once", "twice", "only-old"]);
      expect(oneRun.records).toEqual([]);

      const other = memory("other", { runPublicId: "arun_y", createdAt: daysAgo(1) });
      const twoRuns = planCuration(
        input({ waiting: [before, once, twice, other, onlyOld], rejections }),
      );
      expect(twoRuns.held).toEqual(["only-old"]);
      expect(cited(twoRuns)).toEqual([["before", "once", "twice", "other"]]);
    });

    it("counts no memory with no run toward the 2 runs a rejected statement needs", () => {
      const rejections = [
        { statementHash: statementHash(MIGRATE), rejectedAt: daysAgo(6) },
      ];
      const gateway = { runPublicId: null, capture: "local_gateway" as const };
      const fileA = memory("gateway-a", {
        ...gateway,
        source: "claude-code:memory/a.md",
        createdAt: daysAgo(5),
      });
      const fileB = memory("gateway-b", {
        ...gateway,
        source: "claude-code:memory/b.md",
        createdAt: daysAgo(4),
      });
      const pullRequest = memory("pull-request", {
        runPublicId: null,
        capture: "pull_request",
        source: null,
        createdAt: daysAgo(3),
      });

      const twoFiles = planCuration(input({ waiting: [fileA, fileB], rejections }));
      expect(twoFiles.held).toEqual(["gateway-a", "gateway-b"]);
      expect(twoFiles.records).toEqual([]);

      const runOne = memory("run-1", { createdAt: daysAgo(2) });
      const oneRun = planCuration(
        input({ waiting: [fileA, fileB, pullRequest, runOne], rejections }),
      );
      expect(oneRun.held).toEqual(["gateway-a", "gateway-b", "pull-request", "run-1"]);
      expect(oneRun.records).toEqual([]);

      const runTwo = memory("run-2", { createdAt: daysAgo(1) });
      const twoRuns = planCuration(
        input({ waiting: [fileA, fileB, pullRequest, runOne, runTwo], rejections }),
      );
      expect(twoRuns.held).toEqual([]);
      expect(cited(twoRuns)).toEqual([
        ["gateway-a", "gateway-b", "pull-request", "run-1", "run-2"],
      ]);
    });

    it("counts runs from the latest rejection of a statement", () => {
      const hash = statementHash(MIGRATE);
      const plan = planCuration(
        input({
          waiting: [
            memory("m1", { createdAt: daysAgo(5) }),
            memory("m2", { createdAt: daysAgo(5) }),
          ],
          rejections: [
            { statementHash: hash, rejectedAt: daysAgo(6) },
            { statementHash: hash, rejectedAt: daysAgo(10) },
            { statementHash: hash, rejectedAt: daysAgo(4) },
          ],
        }),
      );
      expect(plan.held).toEqual(["m1", "m2"]);
    });
  });

  describe("grouping", () => {
    it("groups memories that say the same thing inside one shard, in ranking order", () => {
      const plan = planCuration(
        input({
          waiting: [
            memory("again", { statement: MIGRATE_AGAIN, createdAt: daysAgo(1) }),
            memory("repo", { repos: ["github.com/acme/api"], createdAt: daysAgo(3) }),
            memory("first", { createdAt: daysAgo(4) }),
            memory("other", { statement: REFUND, createdAt: daysAgo(2) }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["first", "again"], ["repo"], ["other"]]);
    });

    it("joins a repeated statement that has no content words by its hash", () => {
      const plan = planCuration(
        input({
          waiting: [
            memory("a", { statement: "Do it.", createdAt: daysAgo(2) }),
            memory("b", { statement: "Do it!", createdAt: daysAgo(1) }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["a", "b"]]);
      expect(plan.records[0]?.statementHashes).toEqual([statementHash("Do it.")]);
    });
  });

  describe("batch", () => {
    const batchOf3 = { batch_size: 3, retire_after_days: 180 };

    it("cites whole groups while they fit", () => {
      const plan = planCuration(
        input({
          governance: batchOf3,
          waiting: [
            memory("k1", { statement: KEYS, createdAt: daysAgo(3) }),
            memory("m1", { createdAt: daysAgo(2) }),
            memory("m2", { createdAt: daysAgo(1) }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["k1"], ["m1", "m2"]]);
      expect(plan.deferred).toEqual([]);
    });

    it("stops at the first group that does not fit, and defers every group after it", () => {
      const plan = planCuration(
        input({
          governance: batchOf3,
          waiting: [
            memory("m1", { createdAt: daysAgo(6) }),
            memory("m2", { createdAt: daysAgo(5) }),
            memory("r1", { statement: REFUND, createdAt: daysAgo(4) }),
            memory("r2", { statement: REFUND, createdAt: daysAgo(3) }),
            memory("k1", { statement: KEYS, createdAt: daysAgo(2) }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["m1", "m2"]]);
      expect(plan.deferred).toEqual(["r1", "r2", "k1"]);
    });

    it("cuts a first group larger than the batch, and defers its tail", () => {
      const plan = planCuration(
        input({
          governance: batchOf3,
          waiting: [
            ...[6, 5, 4, 3, 2].map((days) =>
              memory(`m${7 - days}`, { createdAt: daysAgo(days) }),
            ),
            memory("k1", { statement: KEYS, createdAt: daysAgo(1) }),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["m1", "m2", "m3"]]);
      expect(plan.deferred).toEqual(["m4", "m5", "k1"]);
      expect(plan.records[0]?.draft.memories).toHaveLength(3);
    });

    it("defers a large group whole when a group before it was cited", () => {
      const plan = planCuration(
        input({
          governance: batchOf3,
          waiting: [
            memory("k1", { statement: KEYS, createdAt: daysAgo(7) }),
            ...[6, 5, 4, 3].map((days) =>
              memory(`m${7 - days}`, { createdAt: daysAgo(days) }),
            ),
          ],
        }),
      );
      expect(cited(plan)).toEqual([["k1"]]);
      expect(plan.deferred).toEqual(["m1", "m2", "m3", "m4"]);
    });
  });

  describe("file limit", () => {
    /** 300 statements no two of which say the same thing, oldest first. */
    function distinctMemories(count: number): StoredMemory[] {
      return Array.from({ length: count }, (_, i) =>
        memory(`d${i}`, {
          statement: `Keep service ${i} warm`,
          createdAt: new Date(NOW.getTime() - (count - i) * 60_000),
        }),
      );
    }

    it("puts 299 of 305 changes in the PR and queues 6: contradicted records first, stale ones last", () => {
      const contradicted = ["c1", "c2"].map((lineage) =>
        activeRecord(lineage, { statement: MIGRATE }),
      );
      const stale = ["s1", "s2", "s3"].map((lineage) =>
        activeRecord(lineage, { statement: REFUND }),
      );
      const plan = planCuration(
        input({
          governance: { batch_size: 400, retire_after_days: 180 },
          waiting: distinctMemories(300),
          // Stale records come first in the listing, so the order is the plan's.
          records: [...stale, ...contradicted],
          recalls: [
            ...stale.map((r) => stamp(r.lineage, daysAgo(181))),
            ...contradicted.map((r) => stamp(r.lineage, daysAgo(1), daysAgo(10))),
          ],
          reflections: [
            { createdAt: daysAgo(5), lessons: [{ statement: NEVER_MIGRATE }] },
          ],
        }),
      );

      expect(MEMORY_PR_FILES_MAX).toBe(299);
      expect(plan.records.length + plan.retirements.length).toBe(299);
      expect(plan.retirements.map((r) => r.lineage)).toEqual(["c1", "c2"]);
      expect(plan.records).toHaveLength(297);
      expect(plan.records[0]?.memoryIds).toEqual(["d0"]);
      expect(plan.records[296]?.memoryIds).toEqual(["d296"]);
      // The 3 records that did not fit keep their memories waiting for the next PR.
      expect(plan.deferred).toEqual(["d297", "d298", "d299"]);
      expect(plan.queuedRetirements).toEqual(["s1", "s2", "s3"]);
      expect(plan.deferred.length + plan.queuedRetirements.length).toBe(6);
      expect(plan.said).toEqual([]);
      expect(memoryPrBody(plan)).toContain(
        "One memory PR changes at most 299 files, so 3 more records wait for a later memory PR to archive.",
      );
    });

    it("fits exactly 299 changes with nothing queued", () => {
      const plan = planCuration(
        input({
          governance: { batch_size: 400, retire_after_days: 180 },
          waiting: distinctMemories(299),
        }),
      );
      expect(plan.records).toHaveLength(299);
      expect(plan.deferred).toEqual([]);
      expect(plan.queuedRetirements).toEqual([]);
      expect(memoryPrBody(plan)).not.toContain("at most 299 files");
    });

    it("queues stale records once new records fill the PR, and proposes them on a later pass", () => {
      const stale = activeRecord("s1", { statement: REFUND });
      const full = input({
        governance: { batch_size: 400, retire_after_days: 180 },
        waiting: distinctMemories(299),
        records: [stale],
        recalls: [stamp("s1", daysAgo(181))],
      });
      const today = planCuration(full);
      expect(today.retirements).toEqual([]);
      expect(today.queuedRetirements).toEqual(["s1"]);

      const tomorrow = planCuration({ ...full, waiting: [] });
      expect(tomorrow.retirements.map((r) => r.lineage)).toEqual(["s1"]);
      expect(tomorrow.queuedRetirements).toEqual([]);
    });
  });

  describe("records", () => {
    it("writes each record from its group's highest ranked memory and copies every cited memory", () => {
      const repos = ["github.com/acme/api"];
      const plan = planCuration(
        input({
          waiting: [
            memory("rep", {
              kind: "fact",
              repos,
              appliesTo: ["src/billing/**"],
              tools: ["billing__create_refund"],
              agentLineage: null,
              evidence: ["frame:arun_rep/7"],
              createdAt: daysAgo(2),
            }),
            memory("second", {
              statement: MIGRATE_AGAIN,
              repos,
              runPublicId: null,
              capture: "local_gateway",
              source: "claude-code:memory/migrations.md",
              evidence: [],
            }),
            memory("third", { repos }),
          ],
        }),
      );
      const expected: PlannedRecord = {
        path: `steering/memory/github.com/acme/api/billing/${BASE_LINEAGE}.md`,
        draft: {
          lineage: BASE_LINEAGE,
          kind: "fact",
          statement: MIGRATE,
          repos,
          appliesTo: ["src/billing/**"],
          tools: ["billing__create_refund"],
          uri: "https://app.oxagen.ai/runs/arun_rep",
          memories: [
            {
              agent: null,
              run: "arun_rep",
              statement: MIGRATE,
              evidence: ["frame:arun_rep/7"],
            },
            {
              agent: "claude-code",
              run: null,
              statement: MIGRATE_AGAIN,
              evidence: [],
            },
            {
              agent: "claude-code",
              run: "arun_third",
              statement: MIGRATE,
              evidence: ["frame:arun_third/1"],
            },
          ],
        },
        memoryIds: ["rep", "second", "third"],
        statementHashes: [statementHash(MIGRATE), statementHash(MIGRATE_AGAIN)],
      };
      expect(plan.records).toEqual([expected]);
    });

    it("keeps code-rule, business-rule, and fact, and files any other kind as memory", () => {
      const kinds: Array<[RecordKind, RecordKind]> = [
        ["code-rule", "code-rule"],
        ["business-rule", "business-rule"],
        ["fact", "fact"],
        ["preference", "memory"],
        ["procedure", "memory"],
        ["constraint", "memory"],
      ];
      for (const [kind, filed] of kinds) {
        const plan = planCuration(input({ waiting: [memory("m", { kind })] }));
        expect(plan.records[0]?.draft.kind).toBe(filed);
      }
    });

    it("mints a lineage no record, open memory PR, or earlier record in the plan holds", () => {
      const plan = planCuration(
        input({
          records: [
            activeRecord(BASE_LINEAGE, {
              path: `steering/code-rules/${BASE_LINEAGE}.md`,
              kind: "code-rule",
            }),
          ],
          pending: [pendingRecord("retire", `${BASE_LINEAGE}-2`)],
          waiting: [
            memory("workspace", { createdAt: daysAgo(2) }),
            memory("repo", { repos: ["github.com/acme/api"] }),
          ],
        }),
      );
      expect(plan.records.map((record) => record.path)).toEqual([
        `steering/memory/workspace/general/${BASE_LINEAGE}-3.md`,
        `steering/memory/github.com/acme/api/general/${BASE_LINEAGE}-4.md`,
      ]);
      expect(plan.records.map((record) => record.draft.lineage)).toEqual([
        `${BASE_LINEAGE}-3`,
        `${BASE_LINEAGE}-4`,
      ]);
    });

    it("names the first cited run's page, else the first memory's source, else oxagen:memory", () => {
      const plan = planCuration(
        input({
          waiting: [
            memory("no-run", {
              runPublicId: null,
              capture: "pull_request",
              source: "https://github.com/acme/api/pull/9",
              createdAt: daysAgo(6),
            }),
            memory("with-run", { createdAt: daysAgo(5) }),
            memory("sourced", {
              statement: REFUND,
              runPublicId: null,
              capture: "pull_request",
              source: "https://github.com/acme/api/pull/10",
              createdAt: daysAgo(4),
            }),
            memory("bare", {
              statement: KEYS,
              runPublicId: null,
              capture: "local_gateway",
              source: null,
              createdAt: daysAgo(3),
            }),
          ],
        }),
      );
      expect(plan.records.map((record) => record.draft.uri)).toEqual([
        "https://app.oxagen.ai/runs/arun_with-run",
        "https://github.com/acme/api/pull/10",
        "oxagen:memory",
      ]);
    });
  });
});

function plannedRecord(
  path: string,
  statement: string,
  runs: Array<string | null>,
): PlannedRecord {
  return {
    path,
    draft: {
      lineage: "lineage",
      kind: "memory",
      statement,
      repos: null,
      appliesTo: null,
      tools: null,
      uri: "oxagen:memory",
      memories: runs.map((run) => ({
        agent: "claude-code",
        run,
        statement,
        evidence: [],
      })),
    },
    memoryIds: runs.map((_, i) => `m${i}`),
    statementHashes: [statementHash(statement)],
  };
}

const EMPTY_PLAN: CuratePlan = {
  said: [],
  held: [],
  unused: [],
  deferred: [],
  records: [],
  retirements: [],
  queuedRetirements: [],
  stampRecalls: [],
};

describe("memoryPrTitle", () => {
  it("names the day", () => {
    expect(memoryPrTitle("2026-09-26", EMPTY_PLAN)).toBe("Memory PR 2026-09-26");
  });
});

describe("memoryBranch", () => {
  it("is memory/<date>, in UTC", () => {
    expect(memoryBranch(new Date("2026-09-26T23:30:00-05:00"))).toBe(
      "memory/2026-09-27",
    );
    expect(memoryBranch(NOW)).toBe("memory/2026-09-26");
  });
});

describe("memoryPrBody", () => {
  it("lists each proposed record and each record to archive, and says what merging and closing do", () => {
    const body = memoryPrBody({
      ...EMPTY_PLAN,
      records: [
        plannedRecord(
          "steering/memory/workspace/general/run-tests.md",
          "Run the tests\n  before a merge.",
          ["arun_1", "arun_1", "arun_2"],
        ),
        plannedRecord("steering/memory/workspace/general/local.md", "Use pnpm.", [
          null,
        ]),
      ],
      retirements: [
        {
          path: "steering/memory/workspace/general/old.md",
          lineage: "old",
          kind: "memory",
          reason: "stale",
          text: "",
        },
        {
          path: "steering/memory/workspace/general/wrong.md",
          lineage: "wrong",
          kind: "fact",
          reason: "contradicted",
          text: "",
        },
      ],
    });
    expect(body).toContain("It proposes 2 steering records and archives 2 records.");
    expect(body).toContain(
      "- `steering/memory/workspace/general/run-tests.md`. It cites 3 memories from 2 runs.\n  > Run the tests before a merge.",
    );
    expect(body).toContain(
      "- `steering/memory/workspace/general/local.md`. It cites 1 memory with no run.\n  > Use pnpm.",
    );
    expect(body).toContain(
      "- `steering/memory/workspace/general/old.md`. No run recalled it within `retire_after_days`.",
    );
    expect(body).toContain(
      "- `steering/memory/workspace/general/wrong.md`. A reflection written since its last review contradicts it.",
    );
    expect(body).toContain("Merge this PR to adopt every change in it.");
    expect(body).toContain("Close it to reject every change.");
    expect(body).toContain("delete its file before you merge");
    expect(body).not.toMatch(/[—–!]/);
  });

  it("counts one of each in the singular and leaves out an empty section", () => {
    const one = memoryPrBody({
      ...EMPTY_PLAN,
      records: [
        plannedRecord("steering/memory/workspace/general/a.md", "Use pnpm.", [
          "arun_1",
        ]),
      ],
    });
    expect(one).toContain("It proposes 1 steering record and archives 0 records.");
    expect(one).toContain("It cites 1 memory from 1 run.");
    expect(one).toContain("## Proposed steering records");
    expect(one).not.toContain("## Records to archive");

    const none = memoryPrBody({
      ...EMPTY_PLAN,
      retirements: [
        {
          path: "steering/memory/workspace/general/old.md",
          lineage: "old",
          kind: "memory",
          reason: "stale",
          text: "",
        },
      ],
    });
    expect(none).toContain("It proposes 0 steering records and archives 1 record.");
    expect(none).not.toContain("## Proposed steering records");
    expect(none).toContain("## Records to archive");
  });
});
