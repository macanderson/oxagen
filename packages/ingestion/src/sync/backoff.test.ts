import { describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  ERRORED_AFTER_FAILURES,
  backoffMs,
  healthForFailureCount,
  nextPollAt,
} from "./backoff";

describe("healthForFailureCount", () => {
  it("is healthy at zero failures", () => {
    expect(healthForFailureCount(0)).toBe("healthy");
    expect(healthForFailureCount(-3)).toBe("healthy");
  });

  it("is degraded for 1..(threshold-1) failures", () => {
    for (let n = 1; n < ERRORED_AFTER_FAILURES; n++) {
      expect(healthForFailureCount(n)).toBe("degraded");
    }
  });

  it("escalates to errored at the threshold and beyond", () => {
    expect(healthForFailureCount(ERRORED_AFTER_FAILURES)).toBe("errored");
    expect(healthForFailureCount(ERRORED_AFTER_FAILURES + 10)).toBe("errored");
  });
});

describe("backoffMs", () => {
  // Deterministic: random()=1 gives the full (upper) jittered value.
  const full = () => 1;
  // random()=0 gives the 50% floor.
  const floor = () => 0;

  it("grows exponentially from BASE with the upper jitter", () => {
    expect(backoffMs(1, full)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2, full)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3, full)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("applies full jitter in [50%, 100%] of the capped value", () => {
    expect(backoffMs(1, floor)).toBe(BASE_BACKOFF_MS * 0.5);
    expect(backoffMs(1, full)).toBe(BASE_BACKOFF_MS);
  });

  it("clamps to MAX_BACKOFF_MS even for huge/overflowing counts", () => {
    expect(backoffMs(1000, full)).toBe(MAX_BACKOFF_MS);
    // 2^(n-1) overflows to Infinity here — Math.min must collapse it, not NaN.
    expect(backoffMs(100000, full)).toBe(MAX_BACKOFF_MS);
  });

  it("treats <1 failures as one attempt (never zero delay)", () => {
    expect(backoffMs(0, full)).toBe(BASE_BACKOFF_MS);
  });
});

describe("nextPollAt", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("schedules steady-state interval on success", () => {
    const at = nextPollAt({
      now,
      intervalSeconds: 300,
      consecutiveFailures: 0,
    });
    expect(at.getTime()).toBe(now.getTime() + 300_000);
  });

  it("schedules jittered backoff on failure", () => {
    const at = nextPollAt({
      now,
      intervalSeconds: 300,
      consecutiveFailures: 2,
      random: () => 1,
    });
    expect(at.getTime()).toBe(now.getTime() + BASE_BACKOFF_MS * 2);
  });

  it("never schedules a zero/negative interval", () => {
    const at = nextPollAt({ now, intervalSeconds: 0, consecutiveFailures: 0 });
    expect(at.getTime()).toBeGreaterThan(now.getTime());
  });
});
