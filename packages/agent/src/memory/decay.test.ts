/**
 * Unit tests for memory decay math.
 *
 * The `halfLifeForWeight` and `calcNewConfidence` functions are inline in
 * packages/inngest-functions/src/functions/memory.decay-pass.ts and not
 * exported. We re-implement the identical math here and validate the
 * formula is correct for boundary conditions. These tests serve as a
 * living spec for the decay algorithm.
 */
import { describe, expect, it } from "vitest";

// Pure math helpers — mirrors the inline functions in memory.decay-pass.ts.
// Must stay in sync with the implementation there.

function halfLifeForWeight(
  weight: string,
  halfLifeLowDays: number,
  halfLifeHighDays: number,
): number | null {
  if (weight === "critical") return null;
  if (weight === "high") return halfLifeHighDays;
  // 'low', 'medium', or any unknown weight uses the low half-life.
  return halfLifeLowDays;
}

function calcNewConfidence(
  confidence: number,
  halfLifeDays: number,
  lastReinforcedAt: string | null,
  createdAt: string,
): number {
  const anchor = lastReinforcedAt ?? createdAt;
  const daysSince = (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = confidence * Math.exp((-Math.LN2 / halfLifeDays) * daysSince);
  return Math.max(0, decayed);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("halfLifeForWeight", () => {
  it("returns null for critical weight (never decays)", () => {
    expect(halfLifeForWeight("critical", 30, 90)).toBeNull();
  });

  it("returns halfLifeHighDays for high weight", () => {
    expect(halfLifeForWeight("high", 30, 90)).toBe(90);
  });

  it("returns halfLifeLowDays for low weight", () => {
    expect(halfLifeForWeight("low", 30, 90)).toBe(30);
  });

  it("returns halfLifeLowDays for unknown/unrecognised weight", () => {
    expect(halfLifeForWeight("medium", 30, 90)).toBe(30);
    expect(halfLifeForWeight("whatever", 14, 60)).toBe(14);
  });

  it("respects custom half-life values", () => {
    expect(halfLifeForWeight("high", 14, 60)).toBe(60);
    expect(halfLifeForWeight("low", 14, 60)).toBe(14);
  });
});

describe("calcNewConfidence", () => {
  it("drops to ~0.5 after exactly one half-life (30 days)", () => {
    const anchor = daysAgoIso(30);
    const result = calcNewConfidence(1.0, 30, null, anchor);
    // exp(-ln2 / 30 * 30) = exp(-ln2) = 0.5
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("drops to ~0.5 after exactly one half-life (90 days)", () => {
    const anchor = daysAgoIso(90);
    const result = calcNewConfidence(1.0, 90, null, anchor);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("drops to ~0.25 after two half-lives (60 days with 30-day half-life)", () => {
    const anchor = daysAgoIso(60);
    const result = calcNewConfidence(1.0, 30, null, anchor);
    // exp(-ln2 / 30 * 60) = exp(-2*ln2) = 0.25
    expect(result).toBeCloseTo(0.25, 1);
  });

  it("returns ~1.0 when anchor is now (no decay has occurred)", () => {
    const anchor = new Date().toISOString();
    const result = calcNewConfidence(1.0, 30, null, anchor);
    expect(result).toBeGreaterThan(0.99);
  });

  it("halves a starting confidence of 0.5 after one half-life", () => {
    const anchor = daysAgoIso(30);
    const result = calcNewConfidence(0.5, 30, null, anchor);
    expect(result).toBeCloseTo(0.25, 1);
  });

  it("uses lastReinforcedAt as the anchor when provided, ignoring createdAt", () => {
    // lastReinforcedAt = now → no decay expected regardless of old createdAt
    const createdAt = daysAgoIso(90); // very old
    const lastReinforcedAt = new Date().toISOString(); // just now
    const result = calcNewConfidence(1.0, 30, lastReinforcedAt, createdAt);
    expect(result).toBeGreaterThan(0.99);
  });

  it("falls back to createdAt when lastReinforcedAt is null", () => {
    const createdAt = daysAgoIso(30);
    const result = calcNewConfidence(1.0, 30, null, createdAt);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("never returns a value below 0", () => {
    // Extremely old anchor should drive confidence toward 0 but not below.
    const anchor = daysAgoIso(10_000);
    const result = calcNewConfidence(1.0, 30, null, anchor);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("preserves monotonicity — more time always means lower confidence", () => {
    const anchor30 = daysAgoIso(30);
    const anchor60 = daysAgoIso(60);
    const after30 = calcNewConfidence(1.0, 30, null, anchor30);
    const after60 = calcNewConfidence(1.0, 30, null, anchor60);
    expect(after30).toBeGreaterThan(after60);
  });
});

describe("reinforcement cap math", () => {
  it("caps confidence at 1.0 when delta would exceed the ceiling", () => {
    const current = 0.98;
    const delta = 0.05;
    const capped = Math.min(current + delta, 1.0);
    expect(capped).toBe(1.0);
  });

  it("applies delta without capping when result stays below 1.0", () => {
    const current = 0.8;
    const delta = 0.05;
    const result = Math.min(current + delta, 1.0);
    expect(result).toBeCloseTo(0.85, 5);
  });

  it("stays at exactly 1.0 when current is already 1.0 and delta is positive", () => {
    const capped = Math.min(1.0 + 0.1, 1.0);
    expect(capped).toBe(1.0);
  });

  it("zero delta leaves confidence unchanged", () => {
    const current = 0.72;
    const result = Math.min(current + 0, 1.0);
    expect(result).toBe(0.72);
  });
});
