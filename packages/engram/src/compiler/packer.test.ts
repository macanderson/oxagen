/**
 * Tests for compiler/packer.ts (P0-2): the budget invariant must hold even for
 * token-dense (code) bodies, and pinned overflow must truncate lowest-salience
 * rules rather than blow the budget.
 */
import { describe, it, expect } from "vitest";
import { pack, type TokenBudget } from "./packer";
import { createRecord } from "../record";
import type { RetrievalCandidate } from "../retrieval/types";
import type { MemoryRecord, Namespace, Provenance } from "../types";

const NS: Namespace = { org: "o", workspace: "w" };
const PROV: Provenance = {
  author: "t",
  derivedFrom: [],
  timestamp: 1700000000000,
};

// A dense code-ish body: chars/4 badly under-counts its real token cost.
const CODE = "const x=[1,2,3].map((n)=>n*2).filter(Boolean);".repeat(20);

function semantic(fact: string, salience = 0.5): MemoryRecord {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain: "code" },
    salience,
    confidence: 1,
    provenance: PROV,
    createdAt: 1700000000000,
  });
}

function procedural(rule: string, salience: number): MemoryRecord {
  return createRecord({
    kind: "procedural",
    namespace: NS,
    body: { rule, appliesTo: [], successCount: 0, failureCount: 0 },
    salience,
    confidence: 1,
    provenance: PROV,
    createdAt: 1700000000000,
  });
}

function cand(record: MemoryRecord, score: number): RetrievalCandidate {
  // Deliberately understate tokenCost (chars/4-style) — the packer must not
  // trust this for budget gating.
  const tokenCost = Math.ceil(JSON.stringify(record.body).length / 8);
  return { record, score, source: "lexical", tokenCost };
}

function budget(total: number): TokenBudget {
  const system = Math.floor(total * 0.02);
  const working = Math.floor(total * 0.08);
  const procedural = Math.floor(total * 0.04);
  return {
    total,
    reserved: {
      system,
      procedural,
      working,
      volatile: total - system - working - procedural,
    },
  };
}

describe("pack() budget invariant", () => {
  it("never exceeds budget.total even with token-dense bodies", () => {
    const candidates = Array.from({ length: 40 }, (_, i) =>
      cand(semantic(`${CODE}#${i}`, 0.9), 0.9),
    );
    const result = pack({
      candidates,
      budget: budget(2000),
      pinnedRecords: [],
      diversityConstraint: 100,
      modelId: "gpt-4o",
    });
    expect(result.tokenUsage.total).toBeLessThanOrEqual(2000);
    expect(result.tokenUsage.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it("truncates lowest-salience pinned rules when the pinned set overflows", () => {
    // Three heavy pinned rules that can't all fit into a tiny budget.
    const hi = procedural(`HIGH ${CODE}`, 0.99);
    const mid = procedural(`MID ${CODE}`, 0.9);
    const lo = procedural(`LOW ${CODE}`, 0.8);
    const result = pack({
      candidates: [],
      budget: budget(400),
      pinnedRecords: [lo, hi, mid],
      diversityConstraint: 10,
      modelId: "gpt-4o",
    });
    expect(result.tokenUsage.total).toBeLessThanOrEqual(400);
    expect(result.pinnedTruncated).toBeGreaterThan(0);
    // Whatever survived must be the higher-salience rules — lo drops first.
    const includedIds = new Set(result.included.map((r) => r.id));
    if (result.pinnedTruncated === 1) {
      expect(includedIds.has(lo.id)).toBe(false);
    }
  });

  it("keeps all pinned rules when they fit", () => {
    const rule = procedural("small rule", 1.0);
    const result = pack({
      candidates: [],
      budget: budget(4000),
      pinnedRecords: [rule],
      diversityConstraint: 10,
      modelId: "gpt-4o",
    });
    expect(result.pinnedTruncated).toBe(0);
    expect(result.included.map((r) => r.id)).toContain(rule.id);
  });
});
