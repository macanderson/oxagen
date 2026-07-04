import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSAMPLE_CAP,
  DEFAULT_OVERSAMPLE_FACTOR,
  oversampledLimit,
} from "./ann";

describe("oversampledLimit", () => {
  it("multiplies the limit by the default factor of 3", () => {
    expect(DEFAULT_OVERSAMPLE_FACTOR).toBe(3);
    expect(oversampledLimit(10)).toBe(30);
    expect(oversampledLimit(5)).toBe(15);
    expect(oversampledLimit(1)).toBe(3);
  });

  it("honours a custom factor", () => {
    expect(oversampledLimit(10, 2)).toBe(20);
    expect(oversampledLimit(10, 5)).toBe(50);
  });

  it("caps the fetch so a large limit can't explode the query", () => {
    // 300 × 3 = 900, capped to the default 500.
    expect(oversampledLimit(300)).toBe(DEFAULT_OVERSAMPLE_CAP);
    expect(oversampledLimit(300)).toBe(500);
  });

  it("fetches exactly the limit (no oversample headroom) once the limit itself exceeds the cap", () => {
    // 1000 > 500: over-sampling would breach the cap, but we can never fetch
    // fewer than the requested limit, so we fetch exactly the limit.
    expect(oversampledLimit(1000)).toBe(1000);
  });

  it("honours a custom cap", () => {
    expect(oversampledLimit(100, 3, 50)).toBe(100); // cap can't drop below limit
    expect(oversampledLimit(20, 3, 40)).toBe(40); // 60 → capped to 40
    expect(oversampledLimit(20, 3, 100)).toBe(60); // under cap, no clamp
  });

  it("never returns fewer than the requested limit even with a tiny cap", () => {
    // A misconfigured cap below the limit must not cause under-fetching.
    expect(oversampledLimit(30, 3, 10)).toBe(30);
    expect(oversampledLimit(30, 1, 5)).toBe(30);
  });

  it("truncates a fractional limit before over-sampling", () => {
    expect(oversampledLimit(4.9)).toBe(12); // trunc(4.9)=4 → 12
  });

  it("clamps an out-of-range factor to at least 1", () => {
    expect(oversampledLimit(10, 0)).toBe(10);
    expect(oversampledLimit(10, -5)).toBe(10);
    expect(oversampledLimit(10, 0.5)).toBe(10);
  });

  it("returns 0 for a non-positive or non-finite limit", () => {
    expect(oversampledLimit(0)).toBe(0);
    expect(oversampledLimit(-3)).toBe(0);
    expect(oversampledLimit(Number.NaN)).toBe(0);
    expect(oversampledLimit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
