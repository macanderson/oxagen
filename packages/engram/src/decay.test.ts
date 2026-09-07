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

/**
 * #1367 asked for a test that pins the PROMISE rather than the mechanism —
 * the module header's first sentence, "frequently-used, outcome-positive
 * memories resist decay. Unused memories fade faster." The old suite passed
 * without asserting it, which is how the header and the code came to disagree
 * for as long as they did.
 */
describe("decay resists use, not just time (#1367)", () => {
  const YEAR = 365 * 24 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;

  /** Retrieved regularly: the last reinforcement was yesterday. */
  const used = () =>
    record({ createdAt: NOW - YEAR, lastReinforcedAt: NOW - DAY });
  /** Written a year ago and never touched since. */
  const untouched = () => record({ createdAt: NOW - YEAR });

  it("does not evict a record that is still being used, a year after creation", () => {
    const candidates = identifyEvictionCandidates(
      [used()],
      NOW,
      new Map([[used().id, { retrievals: 40, successes: 12 }]]),
    );
    expect(candidates).toHaveLength(0);
  });

  it("does evict one nothing has touched", () => {
    const candidates = identifyEvictionCandidates(
      [untouched()],
      NOW,
      new Map(),
    );
    expect(candidates).toHaveLength(1);
  });

  it("separates the two by orders of magnitude, not by 23 days", () => {
    const usedSalience = effectiveSalience(used(), NOW, 40, 12);
    const deadSalience = effectiveSalience(untouched(), NOW, 0, 0);
    expect(usedSalience).toBeGreaterThan(DEFAULT_DECAY_CONFIG.minSalience);
    expect(deadSalience).toBeLessThan(DEFAULT_DECAY_CONFIG.minSalience);
  });

  it("takes recency from the tracker's observed retrieval, not only the record", () => {
    // The durable field has not been written back yet; the in-memory tracker
    // is the only thing that knows this record was just used.
    const r = untouched();
    const fresh = identifyEvictionCandidates(
      [r],
      NOW,
      new Map([
        [r.id, { retrievals: 5, successes: 2, lastRetrievedAt: NOW - DAY }],
      ]),
    );
    expect(fresh).toHaveLength(0);
  });

  it("lets a heavily-used record go once it is genuinely stale", () => {
    // The stated policy: reinforcement holds a memory alive while it keeps
    // being used, plus the floor window — not forever.
    const stale = record({
      createdAt: NOW - 2 * YEAR,
      lastReinforcedAt:
        NOW - DEFAULT_DECAY_CONFIG.reinforcementFloorWindow - DAY,
    });
    const candidates = identifyEvictionCandidates(
      [stale],
      NOW,
      new Map([[stale.id, { retrievals: 1000, successes: 100 }]]),
    );
    expect(candidates).toHaveLength(1);
  });

  it("still holds it inside the window", () => {
    const justInside = record({
      createdAt: NOW - 2 * YEAR,
      lastReinforcedAt:
        NOW - DEFAULT_DECAY_CONFIG.reinforcementFloorWindow + DAY,
    });
    const candidates = identifyEvictionCandidates(
      [justInside],
      NOW,
      new Map([[justInside.id, { retrievals: 1000, successes: 100 }]]),
    );
    expect(candidates).toHaveLength(0);
  });

  it("does not floor a record below the reinforcement threshold", () => {
    // One or two retrievals is not "frequently used"; recency alone decides.
    const barely = record({
      createdAt: NOW - YEAR,
      lastReinforcedAt: NOW - YEAR,
    });
    expect(
      identifyEvictionCandidates(
        [barely],
        NOW,
        new Map([[barely.id, { retrievals: 1, successes: 0 }]]),
      ),
    ).toHaveLength(1);
  });

  it("leaves a never-reinforced record decaying exactly as before", () => {
    // Backwards compatibility: with no lastReinforcedAt and no observed
    // retrieval, the anchor is createdAt — the old behaviour.
    const r = record({ createdAt: NOW - DEFAULT_DECAY_CONFIG.halfLife });
    expect(effectiveSalience(r, NOW, 0, 0)).toBeCloseTo(0.25, 2);
  });
});
