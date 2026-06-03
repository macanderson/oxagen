import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usageVolumeDiscount } from "./discount";

// The function reads the three discount knobs from the environment via
// requireEnv. Set them explicitly so the test is independent of deploy config.
const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env.OXAGEN_USAGE_DISCOUNT_PERCENT = "3";
  process.env.OXAGEN_USAGE_DISCOUNT_INCREMENT = "50";
  process.env.OXAGEN_USAGE_DISCOUNT_CEILING_USD = "250";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("usageVolumeDiscount", () => {
  it("gives no discount below the first increment", () => {
    expect(usageVolumeDiscount(4900).percent).toBe(0); // $49
    expect(usageVolumeDiscount(0).percent).toBe(0);
    expect(usageVolumeDiscount(4900).priceCents).toBe(4900);
    expect(usageVolumeDiscount(4900).savedCents).toBe(0);
  });

  it("steps 3% per $50 increment", () => {
    expect(usageVolumeDiscount(5000).percent).toBe(3); // $50  → 1 step
    expect(usageVolumeDiscount(10000).percent).toBe(6); // $100 → 2 steps
    expect(usageVolumeDiscount(15000).percent).toBe(9); // $150
    expect(usageVolumeDiscount(20000).percent).toBe(12); // $200
  });

  it("hits the stated 15% max at the $250 ceiling", () => {
    const d = usageVolumeDiscount(25000); // $250
    expect(d.increments).toBe(5);
    expect(d.percent).toBe(15);
    expect(d.savedCents).toBe(3750); // 15% of $250 = $37.50
    expect(d.priceCents).toBe(21250); // pays $212.50 for $250 of credits
  });

  it("stays flat at the max above the ceiling", () => {
    expect(usageVolumeDiscount(30000).percent).toBe(15); // $300 still 15%
    expect(usageVolumeDiscount(100000).percent).toBe(15); // $1000 still 15%
    // The discount applies to the WHOLE grant, so savings scale with grant size.
    expect(usageVolumeDiscount(100000).savedCents).toBe(15000); // 15% of $1000
  });

  it("uses partial increments by floor (mid-band gets the lower step)", () => {
    expect(usageVolumeDiscount(7500).percent).toBe(3); // $75 → 1 step (not 1.5)
    expect(usageVolumeDiscount(24999).percent).toBe(12); // $249.99 → 4 steps
  });

  it("respects operator-tuned env values", () => {
    process.env.OXAGEN_USAGE_DISCOUNT_PERCENT = "2.5";
    process.env.OXAGEN_USAGE_DISCOUNT_INCREMENT = "100";
    process.env.OXAGEN_USAGE_DISCOUNT_CEILING_USD = "500";
    const d = usageVolumeDiscount(50000); // $500 → 5 steps × 2.5% = 12.5%
    expect(d.increments).toBe(5);
    expect(d.percent).toBe(12.5);
  });

  it("rejects negative or non-finite grants", () => {
    expect(() => usageVolumeDiscount(-1)).toThrow(RangeError);
    expect(() => usageVolumeDiscount(Number.NaN)).toThrow(RangeError);
  });
});
