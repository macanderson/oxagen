/**
 * Regression tests for the consolidation "landmines" that had to be fixed
 * before the nightly job could be wired (PR 2): C-1 dedupe, C-2 resolve
 * ordering, C-3 pattern segmentation/promotion, and #9 distill identity.
 */
import { describe, it, expect } from "vitest";
import { createRecord } from "../record";
import type {
  MemoryRecord,
  Namespace,
  Provenance,
  SemanticBody,
} from "../types";
import { deduplicateSemanticRecords } from "./dedupe";
import { resolveConflict } from "./resolve";
import { extractToolSequences, detectPatterns } from "./patterns";
import { promotePatterns, type PromotionConfig } from "./promote";
import { distill, extractFactHeuristic } from "./distill";

const NS: Namespace = { org: "o", workspace: "w" };
const PROV: Provenance = {
  author: "t",
  derivedFrom: [],
  timestamp: 1_700_000_000_000,
};

function semantic(
  fact: string,
  domain: string,
  confidence = 0.8,
): MemoryRecord {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain } satisfies SemanticBody,
    salience: 0.6,
    confidence,
    provenance: PROV,
    createdAt: 1_700_000_000_000,
  });
}

function toolCall(
  tool: string,
  outcome: "success" | "failure",
  turnId?: string,
  at = 1_700_000_000_000,
) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event: "tool_call", payload: { tool, turnId }, outcome },
    salience: 0.5,
    confidence: 1,
    provenance: PROV,
    createdAt: at,
  });
}

function marker(event: string, turnId?: string, at = 1_700_000_000_000) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: { turnId }, outcome: "success" },
    salience: 0.5,
    confidence: 1,
    provenance: PROV,
    createdAt: at,
  });
}

describe("C-1 deduplicateSemanticRecords", () => {
  it("passes non-semantic records through untouched", () => {
    const episodic = toolCall("grep", "success");
    const a = semantic("The API uses REST", "api", 0.9);
    const b = semantic("The API uses REST", "api", 0.7);
    const result = deduplicateSemanticRecords([episodic, a, b]);
    // Episodic survives; the two semantics collapse to the higher-confidence one.
    expect(result.unique.map((r) => r.id)).toContain(episodic.id);
    expect(result.unique.filter((r) => r.kind === "semantic")).toHaveLength(1);
  });

  it("records the real similarity, not a hard-coded 1.0", () => {
    // Jaccard ≈ 5/6: overlapping but not identical, so the recorded similarity
    // must be strictly between 0 and 1 (the old code hard-coded 1.0).
    const a = semantic("database connection pool size tuning", "db", 0.9);
    const b = semantic("database connection pool size tuning guide", "db", 0.7);
    const result = deduplicateSemanticRecords([a, b], 0.5);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.similarity).toBeGreaterThan(0);
    expect(result.duplicates[0]!.similarity).toBeLessThan(1);
  });

  it("does not compare facts across different domains (domain blocking)", () => {
    const a = semantic("uses connection pooling", "db");
    const b = semantic("uses connection pooling", "api");
    const result = deduplicateSemanticRecords([a, b], 0.5);
    expect(result.unique.filter((r) => r.kind === "semantic")).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });
});

describe("C-2 resolveConflict ordering", () => {
  it("escalates two high-confidence facts to human_review even with strong evidence", () => {
    const existing = semantic(
      "The service stores tokens encrypted",
      "security",
      0.95,
    );
    const newFact: SemanticBody = {
      fact: "The service stores tokens in plaintext",
      domain: "security",
    };
    // 6 pieces of evidence would have auto-resolved to keep_new before the fix.
    const result = resolveConflict(existing, newFact, 0.93, [
      "e1",
      "e2",
      "e3",
      "e4",
      "e5",
      "e6",
    ]);
    expect(result.resolution).toBe("human_review");
  });
});

describe("C-3 extractToolSequences turn segmentation", () => {
  it("does not let a sequence span turns (turnId change)", () => {
    const seqs = extractToolSequences([
      toolCall("read", "success", "t1"),
      toolCall("edit", "success", "t1"),
      toolCall("deploy", "success", "t2"),
    ]);
    // Two sequences: [read, edit] in t1, [deploy] in t2 — never [read, edit, deploy].
    expect(seqs.map((s) => s.tools)).toEqual([["read", "edit"], ["deploy"]]);
  });

  it("flushes on an explicit turn_end marker", () => {
    const seqs = extractToolSequences([
      toolCall("read", "success", "t1"),
      marker("turn_end", "t1"),
      toolCall("edit", "success", "t2"),
    ]);
    expect(seqs.map((s) => s.tools)).toEqual([["read"], ["edit"]]);
  });

  it("carries event ids and occurrence times aligned with tools", () => {
    const read = toolCall("read", "success", "t1", 111);
    const edit = toolCall("edit", "success", "t1", 222);
    const seqs = extractToolSequences([read, edit, marker("decision", "t1")]);
    expect(seqs[0]!.eventIds).toEqual([read.id, edit.id]);
    expect(seqs[0]!.timestamps).toEqual([111, 222]);
  });
});

describe("C-3 detectPatterns", () => {
  it("stores concrete event ids as examples and uses event time for lastSeen", () => {
    const mkSession = (t: number) => {
      const read = toolCall("read", "success", "t1", t);
      const edit = toolCall("edit", "success", "t1", t + 1);
      return [read, edit, marker("decision", "t1", t + 2)];
    };
    const sessions = [mkSession(1000), mkSession(2000), mkSession(3000)];
    const patterns = detectPatterns(sessions, {
      minLength: 2,
      maxLength: 5,
      minSuccessRate: 0.7,
      minOccurrences: 2,
    });
    expect(patterns.length).toBeGreaterThan(0);
    const p = patterns[0]!;
    // Examples are 64-char content-hash ids, not the "read → edit" n-gram string.
    expect(p.examples.every((e) => /^[0-9a-f]{64}$/.test(e))).toBe(true);
    // lastSeen is the newest event time (3001), not Date.now().
    expect(p.lastSeen).toBe(3001);
  });
});

describe("C-3 promotePatterns", () => {
  const cfg: PromotionConfig = { minSuccessRate: 0.8, minPromotionCount: 5 };

  it("gates on TOTAL occurrences (success + failure), not successCount alone", () => {
    // successCount 4 would fail the old `successCount >= 5` gate, but total is
    // 5 with an 80% rate, so it should promote.
    const pattern = {
      sequence: ["a", "b"],
      successCount: 4,
      failureCount: 1,
      successRate: 0.8,
      lastSeen: 0,
      examples: ["e1"],
    };
    expect(promotePatterns([pattern], [], cfg)).toHaveLength(1);
  });

  it("treats capture as order-sensitive (b → a is not captured by an a → b rule)", () => {
    const rule = createRecord({
      kind: "procedural",
      namespace: NS,
      body: {
        rule: "use the sequence: a → b. This pattern has a 90% success rate.",
        appliesTo: ["a", "b"],
        successCount: 9,
        failureCount: 1,
      },
      salience: 1,
      confidence: 1,
      provenance: PROV,
      createdAt: 1_700_000_000_000,
    });
    const reversed = {
      sequence: ["b", "a"],
      successCount: 9,
      failureCount: 0,
      successRate: 1,
      lastSeen: 0,
      examples: ["e"],
    };
    // b → a is a different pattern, so it is NOT already captured → promoted.
    expect(promotePatterns([reversed], [rule], cfg)).toHaveLength(1);
  });
});

describe("#9 distill findExistingFact", () => {
  const cluster = [
    toolCall("grep", "success"),
    toolCall("grep", "success"),
    toolCall("grep", "success"),
  ];

  it("inserts a genuinely different same-domain fact instead of always matching", async () => {
    const unrelated = semantic(
      "The database uses PostgreSQL with pgvector",
      "general",
      0.7,
    );
    const result = await distill(cluster, [unrelated]);
    // The old includes("") bug matched the first same-domain fact every time,
    // so nothing was ever inserted. The distinct fact must be inserted.
    expect(result.newFacts).toHaveLength(1);
    expect(result.boostedFacts).toHaveLength(0);
  });

  it("boosts a near-identical existing fact instead of duplicating it", async () => {
    const heuristic = extractFactHeuristic(cluster)!;
    const existing = semantic(heuristic.fact, heuristic.domain, 0.7);
    const result = await distill(cluster, [existing]);
    expect(result.newFacts).toHaveLength(0);
    expect(result.boostedFacts).toHaveLength(1);
  });
});
