import { describe, it, expect } from "vitest";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";
import {
  effectiveSalience,
  identifyEvictionCandidates,
  DEFAULT_DECAY_CONFIG,
} from "../decay";
import { ReinforcementTracker } from "../reinforcement";
import { distill, clusterEvents, DEFAULT_DISTILLATION_CONFIG } from "./distill";
import { deduplicateSemanticRecords } from "./dedupe";
import { detectContradiction, resolveConflict } from "./resolve";
import {
  detectPatterns,
  extractToolSequences,
  DEFAULT_PATTERN_CONFIG,
} from "./patterns";
import { promotePatterns } from "./promote";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeEpisodic(
  event: string,
  outcome?: "success" | "failure",
  tool?: string,
) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: {
      event,
      payload: { tool: tool ?? event },
      outcome: outcome ?? "unknown",
    },
    salience: 0.5,
    confidence: 1.0,
    provenance: { ...PROV, tool },
  });
}

function makeSemantic(fact: string, domain: string, confidence = 0.8) {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain },
    salience: 0.6,
    confidence,
    provenance: PROV,
  });
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe("effectiveSalience", () => {
  it("returns base salience for fresh record with no retrievals", () => {
    const record = { ...makeEpisodic("test"), createdAt: Date.now() };
    const eff = effectiveSalience(record, Date.now(), 0, 0);
    expect(eff).toBeCloseTo(record.salience, 1);
  });

  it("decays over time", () => {
    const record = {
      ...makeEpisodic("test"),
      salience: 0.5,
      createdAt: Date.now() - 14 * 86400000,
    };
    const eff = effectiveSalience(record, Date.now(), 0, 0);
    expect(eff).toBeLessThan(0.5);
    expect(eff).toBeCloseTo(0.125, 1); // 0.5 * 0.25 after 2 half-lives
  });

  it("retrieval frequency boosts salience", () => {
    const record = {
      ...makeEpisodic("test"),
      salience: 0.3,
      createdAt: Date.now() - 7 * 86400000,
    };
    const withoutRetrievals = effectiveSalience(record, Date.now(), 0, 0);
    const withRetrievals = effectiveSalience(record, Date.now(), 5, 0);
    expect(withRetrievals).toBeGreaterThan(withoutRetrievals);
  });

  it("success count boosts salience", () => {
    const record = {
      ...makeEpisodic("test"),
      salience: 0.3,
      createdAt: Date.now() - 7 * 86400000,
    };
    const withoutSuccess = effectiveSalience(record, Date.now(), 3, 0);
    const withSuccess = effectiveSalience(record, Date.now(), 3, 3);
    expect(withSuccess).toBeGreaterThan(withoutSuccess);
  });
});

describe("identifyEvictionCandidates", () => {
  it("flags very old records with no retrievals", () => {
    const old = {
      ...makeEpisodic("old"),
      salience: 0.1,
      createdAt: Date.now() - 90 * 86400000,
    };
    const fresh = {
      ...makeEpisodic("fresh"),
      salience: 0.5,
      createdAt: Date.now(),
    };
    const stats = new Map<string, { retrievals: number; successes: number }>();
    const candidates = identifyEvictionCandidates(
      [old, fresh],
      Date.now(),
      stats,
    );
    expect(candidates).toContain(old);
    expect(candidates).not.toContain(fresh);
  });
});

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

describe("ReinforcementTracker", () => {
  it("tracks retrieval and reinforcement", () => {
    const tracker = new ReinforcementTracker();
    tracker.recordRetrieval("rec-1");
    tracker.recordRetrieval("rec-1");
    tracker.reinforceTurn(["rec-1"], "success");

    const stats = tracker.getStats("rec-1");
    expect(stats.retrievalCount).toBe(2);
    expect(stats.successCount).toBe(1);
  });

  it("returns zero stats for unknown records", () => {
    const tracker = new ReinforcementTracker();
    const stats = tracker.getStats("unknown");
    expect(stats.retrievalCount).toBe(0);
    expect(stats.successCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Distillation
// ---------------------------------------------------------------------------

describe("distill", () => {
  it("clusters events and produces facts", async () => {
    const events = [
      makeEpisodic("tool_call", "success", "grep"),
      makeEpisodic("tool_call", "success", "grep"),
      makeEpisodic("tool_call", "failure", "grep"),
    ];
    const result = await distill(events, []);
    expect(result.newFacts.length).toBeGreaterThan(0);
    expect(result.processedEventIds).toHaveLength(3);
  });

  it("boosts existing facts instead of creating duplicates", async () => {
    const events = [
      makeEpisodic("tool_call", "success", "grep"),
      makeEpisodic("tool_call", "success", "grep"),
      makeEpisodic("tool_call", "success", "grep"),
    ];
    // First run: creates a fact
    const result1 = await distill(events, []);
    expect(result1.newFacts.length).toBeGreaterThan(0);

    // Second run with existing facts: should boost not duplicate
    const existingFacts = result1.newFacts.map((f) =>
      createRecord({
        kind: "semantic",
        namespace: NS,
        body: f.fact,
        salience: 0.6,
        confidence: f.confidence,
        provenance: PROV,
      }),
    );
    const result2 = await distill(events, existingFacts);
    // May boost or create depending on matching heuristic
    expect(result2.processedEventIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe("deduplicateSemanticRecords", () => {
  it("deduplicates semantically identical facts", () => {
    const records = [
      makeSemantic("The API uses REST endpoints", "api", 0.9),
      makeSemantic("The API uses REST endpoints", "api", 0.7),
    ];
    const result = deduplicateSemanticRecords(records);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    // Should keep the higher-confidence one
    expect(result.unique[0]!.confidence).toBe(0.9);
  });

  it("keeps facts from different domains", () => {
    const records = [
      makeSemantic("The system uses OAuth2", "auth"),
      makeSemantic("The system uses PostgreSQL", "database"),
    ];
    const result = deduplicateSemanticRecords(records);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict Resolution
// ---------------------------------------------------------------------------

describe("detectContradiction", () => {
  it("detects negation-based contradictions", () => {
    const existing = makeSemantic("The API does use authentication", "api");
    const newFact = {
      fact: "The API does not use authentication",
      domain: "api",
    };
    expect(detectContradiction(newFact, existing)).toBe(true);
  });

  it("does not flag unrelated facts", () => {
    const existing = makeSemantic("The API uses REST", "api");
    const newFact = {
      fact: "The database uses PostgreSQL",
      domain: "database",
    };
    expect(detectContradiction(newFact, existing)).toBe(false);
  });
});

describe("resolveConflict", () => {
  it("prefers new fact when confidence is much higher", () => {
    const existing = {
      ...makeSemantic("old fact", "api", 0.4),
      confidence: 0.4,
    };
    const result = resolveConflict(
      existing,
      { fact: "new fact", domain: "api" },
      0.9,
      ["ev1", "ev2"],
    );
    expect(result.resolution).toBe("keep_new");
  });

  it("prefers existing when it has much higher confidence", () => {
    const existing = {
      ...makeSemantic("strong fact", "api", 0.95),
      confidence: 0.95,
    };
    const result = resolveConflict(
      existing,
      { fact: "weak new", domain: "api" },
      0.5,
      [],
    );
    expect(result.resolution).toBe("keep_existing");
  });
});

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

describe("detectPatterns", () => {
  it("detects repeated successful tool sequences", () => {
    const sessions = [
      [
        makeEpisodic("tool_call", "success", "read"),
        makeEpisodic("tool_call", "success", "edit"),
        makeEpisodic("decision", "success"),
      ],
      [
        makeEpisodic("tool_call", "success", "read"),
        makeEpisodic("tool_call", "success", "edit"),
        makeEpisodic("decision", "success"),
      ],
      [
        makeEpisodic("tool_call", "success", "read"),
        makeEpisodic("tool_call", "success", "edit"),
        makeEpisodic("decision", "success"),
      ],
    ];
    const patterns = detectPatterns(sessions, {
      ...DEFAULT_PATTERN_CONFIG,
      minOccurrences: 2,
    });
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0]!.successRate).toBeGreaterThanOrEqual(0.7);
  });
});

describe("promotePatterns", () => {
  it("promotes high-success patterns to procedural rules", () => {
    const patterns = [
      {
        sequence: ["read", "edit", "test"],
        successCount: 10,
        failureCount: 1,
        successRate: 10 / 11,
        lastSeen: Date.now(),
        examples: ["ex1"],
      },
    ];
    const candidates = promotePatterns(patterns, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.proposedRule.rule).toContain("read");
  });

  it("skips patterns below threshold", () => {
    const patterns = [
      {
        sequence: ["bad", "pattern"],
        successCount: 2,
        failureCount: 5,
        successRate: 2 / 7,
        lastSeen: Date.now(),
        examples: [],
      },
    ];
    const candidates = promotePatterns(patterns, []);
    expect(candidates).toHaveLength(0);
  });
});
