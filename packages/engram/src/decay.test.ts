/**
 * Tests for decay.ts (M-1): poisoned records must become evictable (minimum
 * salience), never NaN — a NaN salience compares false against the eviction
 * threshold and would linger forever.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveSalience,
  identifyEvictionCandidates,
  DEFAULT_DECAY_CONFIG,
} from "./decay";
import type { MemoryRecord } from "./types";

const NOW = 1700000000000;

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "a".repeat(64),
    kind: "episodic",
    namespace: { org: "o", workspace: "w" },
    body: { event: "e", payload: {} },
    salience: 0.5,
    confidence: 1,
    provenance: { author: "t", derivedFrom: [], timestamp: NOW },
    causality: [],
    createdAt: NOW - DEFAULT_DECAY_CONFIG.halfLife,
    ...overrides,
  };
}

describe("effectiveSalience", () => {
  it("returns a finite value for a normal record", () => {
    const s = effectiveSalience(record({}), NOW, 0, 0);
    expect(Number.isFinite(s)).toBe(true);
    // One half-life elapsed with no boosts → ~half the base salience.
    expect(s).toBeCloseTo(0.25, 2);
  });

  it("returns 0 (evictable) for a NaN createdAt instead of NaN", () => {
    const s = effectiveSalience(
      record({ createdAt: NaN as unknown as number }),
      NOW,
      0,
      0,
    );
    expect(s).toBe(0);
  });

  it("returns 0 for a non-finite salience", () => {
    const s = effectiveSalience(
      record({ salience: NaN as unknown as number }),
      NOW,
      0,
      0,
    );
    expect(s).toBe(0);
  });

  it("clamps future createdAt so salience isn't inflated above base", () => {
    const s = effectiveSalience(
      record({ createdAt: NOW + 1_000_000, salience: 0.5 }),
      NOW,
      0,
      0,
    );
    expect(s).toBeLessThanOrEqual(0.5);
    expect(Number.isFinite(s)).toBe(true);
  });

  it("caps at 1.0 with heavy boosts", () => {
    const s = effectiveSalience(
      record({ createdAt: NOW, salience: 1 }),
      NOW,
      10,
      5,
    );
    expect(s).toBe(1);
  });
});

describe("identifyEvictionCandidates", () => {
  it("evicts a poisoned (NaN createdAt) record", () => {
    const poisoned = record({
      id: "b".repeat(64),
      createdAt: NaN as unknown as number,
    });
    const healthy = record({
      id: "c".repeat(64),
      createdAt: NOW,
      salience: 0.9,
    });
    const evicted = identifyEvictionCandidates(
      [poisoned, healthy],
      NOW,
      new Map(),
    );
    expect(evicted.map((r) => r.id)).toContain("b".repeat(64));
    expect(evicted.map((r) => r.id)).not.toContain("c".repeat(64));
  });
});
