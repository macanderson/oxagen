/**
 * Tests for retrieval/fusion.ts (R-3 raw-score ranking, R-4 topK, and the
 * RRF-rank-from-order contract that P0-1 depends on).
 */
import { describe, it, expect } from "vitest";
import { fuseAndRank } from "./fusion";
import { createRecord } from "../record";
import type { RetrievalCandidate } from "./types";
import type { MemoryRecord, Namespace, Provenance } from "../types";

const NS: Namespace = { org: "o", workspace: "w" };
const PROV: Provenance = {
  author: "t",
  derivedFrom: [],
  timestamp: 1700000000000,
};

function rec(fact: string, salience = 0.5): MemoryRecord {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain: "d" },
    salience,
    confidence: 1,
    provenance: PROV,
    // Deterministic createdAt so recency is stable across records.
    createdAt: 1700000000000,
  });
}

function cand(
  record: MemoryRecord,
  score: number,
  tokenCost = 50,
): RetrievalCandidate {
  return { record, score, source: "vector", tokenCost };
}

describe("fuseAndRank", () => {
  it("ranks by RRF rank taken from each engine's array order (P0-1 contract)", () => {
    const a = rec("a");
    const b = rec("b");
    const c = rec("c");
    // a is rank 0 in both engines; c is last in both.
    const engine1 = [cand(a, 0.9), cand(b, 0.8), cand(c, 0.7)];
    const engine2 = [cand(a, 0.9), cand(b, 0.8), cand(c, 0.7)];
    const fused = fuseAndRank([engine1, engine2]);
    expect(fused[0]!.record.id).toBe(a.id);
    expect(fused[2]!.record.id).toBe(c.id);
  });

  it("combines RRF contributions for a record seen by multiple engines", () => {
    const shared = rec("shared");
    const only1 = rec("only1");
    const only2 = rec("only2");
    const fused = fuseAndRank([
      [cand(shared, 0.5), cand(only1, 0.5)],
      [cand(shared, 0.5), cand(only2, 0.5)],
    ]);
    // shared appears once (deduped) and, having RRF from both engines, ranks first.
    expect(fused.filter((c) => c.record.id === shared.id)).toHaveLength(1);
    expect(fused[0]!.record.id).toBe(shared.id);
  });

  it("does not clamp scores — order survives among negative-scoring candidates (R-3)", () => {
    // Heavy token penalty drives weighted sums negative; the old clamp to 0
    // collapsed these to a tie. Distinct token costs must keep a strict order.
    const cheap = rec("cheap");
    const pricey = rec("pricey");
    const weights = {
      relevance: 0,
      recency: 0,
      salience: 0,
      outcome: 0,
      tokenPenalty: 1,
    };
    const fused = fuseAndRank(
      [[cand(cheap, 0.1, 100), cand(pricey, 0.1, 500)]],
      weights,
    );
    // cheap has a smaller penalty → higher (less negative) score → ranks first.
    expect(fused[0]!.record.id).toBe(cheap.id);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
    expect(fused[1]!.score).toBeLessThan(0);
  });

  it("applies the optional topK cap (R-4)", () => {
    const cands = [rec("a"), rec("b"), rec("c"), rec("d")].map((r) =>
      cand(r, 0.5),
    );
    expect(fuseAndRank([cands])).toHaveLength(4);
    expect(fuseAndRank([cands], undefined, 2)).toHaveLength(2);
    expect(fuseAndRank([cands], undefined, 0)).toHaveLength(0);
  });
});
