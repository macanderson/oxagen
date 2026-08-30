/**
 * Unit tests for the two-axis memory decay math (docs/specs/two-axis-memory
 * §7a). `halfLifeForClass` and `calcNewConfidence` are inline in
 * packages/inngest-functions/src/functions/memory.decay-pass.ts and not
 * exported. We re-implement the identical math here and validate the
 * formula is correct for boundary conditions. These tests serve as a
 * living spec for the decay algorithm.
 *
 * Formula (DESIGN.md §7a): new_conf = floor + (conf - floor) * 0.5^(daysSince/halfLifeDays),
 * anchored on last_evidence_at (falling back to createdAt). FACT never decays
 * (half-life is null); OBSERVATION and RULE decay at their class default
 * (or workspace-configured) half-life.
 */
import { describe, expect, it } from "vitest";

// Pure math helpers — mirrors the inline functions in memory.decay-pass.ts.
// Must stay in sync with the implementation there.

function halfLifeForClass(
  memoryClass: string,
  halfLifeLowDays: number,
  halfLifeHighDays: number,
): number | null {
  if (memoryClass === "FACT") return null;
  if (memoryClass === "RULE") return halfLifeHighDays;
  // OBSERVATION, or any unrecognised class, uses the low half-life.
  return halfLifeLowDays;
}

function calcNewConfidence(
  confidenceScore: number,
  halfLifeDays: number,
  decayFloor: number,
  lastEvidenceAt: string | null,
  createdAt: string,
): number {
  const anchor = lastEvidenceAt ?? createdAt;
  const daysSince =
    (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
  const decayed =
    decayFloor +
    (confidenceScore - decayFloor) * Math.pow(0.5, daysSince / halfLifeDays);
  return Math.max(decayFloor, decayed);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("halfLifeForClass", () => {
  it("returns null for FACT (never decays)", () => {
    expect(halfLifeForClass("FACT", 30, 90)).toBeNull();
  });

  it("returns halfLifeHighDays for RULE", () => {
    expect(halfLifeForClass("RULE", 30, 90)).toBe(90);
  });

  it("returns halfLifeLowDays for OBSERVATION", () => {
    expect(halfLifeForClass("OBSERVATION", 30, 90)).toBe(30);
  });

  it("returns halfLifeLowDays for an unrecognised class", () => {
    expect(halfLifeForClass("WHATEVER", 14, 60)).toBe(14);
  });

  it("respects custom half-life values", () => {
    expect(halfLifeForClass("RULE", 14, 60)).toBe(60);
    expect(halfLifeForClass("OBSERVATION", 14, 60)).toBe(14);
  });
});

describe("calcNewConfidence", () => {
  const FLOOR = 5;

  it("drops halfway toward the floor after exactly one half-life (30 days)", () => {
    const anchor = daysAgoIso(30);
    const result = calcNewConfidence(100, 30, FLOOR, null, anchor);
    // floor + (100 - floor) * 0.5 = 5 + 95*0.5 = 52.5
    expect(result).toBeCloseTo(52.5, 1);
  });

  it("drops halfway toward the floor after exactly one half-life (90 days)", () => {
    const anchor = daysAgoIso(90);
    const result = calcNewConfidence(100, 90, FLOOR, null, anchor);
    expect(result).toBeCloseTo(52.5, 1);
  });

  it("drops to a quarter of the way from floor after two half-lives", () => {
    const anchor = daysAgoIso(60);
    const result = calcNewConfidence(100, 30, FLOOR, null, anchor);
    // floor + (100 - floor) * 0.25 = 5 + 95*0.25 = 28.75
    expect(result).toBeCloseTo(28.75, 1);
  });

  it("returns ~100 when anchor is now (no decay has occurred)", () => {
    const anchor = new Date().toISOString();
    const result = calcNewConfidence(100, 30, FLOOR, null, anchor);
    expect(result).toBeGreaterThan(99);
  });

  it("halves the gap above the floor for a lower starting confidence", () => {
    const anchor = daysAgoIso(30);
    const result = calcNewConfidence(50, 30, FLOOR, null, anchor);
    // floor + (50 - floor) * 0.5 = 5 + 45*0.5 = 27.5
    expect(result).toBeCloseTo(27.5, 1);
  });

  it("uses lastEvidenceAt as the anchor when provided, ignoring createdAt", () => {
    // lastEvidenceAt = now → no decay expected regardless of old createdAt
    const createdAt = daysAgoIso(90); // very old
    const lastEvidenceAt = new Date().toISOString(); // just now
    const result = calcNewConfidence(100, 30, FLOOR, lastEvidenceAt, createdAt);
    expect(result).toBeGreaterThan(99);
  });

  it("falls back to createdAt when lastEvidenceAt is null", () => {
    const createdAt = daysAgoIso(30);
    const result = calcNewConfidence(100, 30, FLOOR, null, createdAt);
    expect(result).toBeCloseTo(52.5, 1);
  });

  it("never decays below the floor, even for an extremely old anchor", () => {
    const anchor = daysAgoIso(10_000);
    const result = calcNewConfidence(100, 30, FLOOR, null, anchor);
    expect(result).toBeGreaterThanOrEqual(FLOOR);
    expect(result).toBeCloseTo(FLOOR, 1);
  });

  it("preserves monotonicity — more time always means lower confidence", () => {
    const anchor30 = daysAgoIso(30);
    const anchor60 = daysAgoIso(60);
    const after30 = calcNewConfidence(100, 30, FLOOR, null, anchor30);
    const after60 = calcNewConfidence(100, 30, FLOOR, null, anchor60);
    expect(after30).toBeGreaterThan(after60);
  });

  it("respects a custom decay floor", () => {
    const anchor = daysAgoIso(10_000);
    const result = calcNewConfidence(100, 30, 20, null, anchor);
    expect(result).toBeCloseTo(20, 1);
  });
});

describe("reinforcement cap math (0-100 scale)", () => {
  it("caps confidence at 100 when delta would exceed the ceiling", () => {
    const current = 98;
    const delta = 5;
    const capped = Math.min(current + delta, 100);
    expect(capped).toBe(100);
  });

  it("applies delta without capping when result stays below 100", () => {
    const current = 80;
    const delta = 5;
    const result = Math.min(current + delta, 100);
    expect(result).toBeCloseTo(85, 5);
  });

  it("stays at exactly 100 when current is already 100 and delta is positive", () => {
    const capped = Math.min(100 + 10, 100);
    expect(capped).toBe(100);
  });

  it("zero delta leaves confidence unchanged", () => {
    const current = 72;
    const result = Math.min(current + 0, 100);
    expect(result).toBe(72);
  });
});
