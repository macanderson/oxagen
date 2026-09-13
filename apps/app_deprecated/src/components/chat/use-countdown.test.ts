// @vitest-environment jsdom
/**
 * use-countdown.test.ts — unit tests for the shared countdown hook + formatter
 * extracted from ConsentCard / ApprovalCard.
 *
 * Uses renderHook + fake timers with a pinned system clock so the exact
 * remaining-ms math is deterministic (advanceTimersByTime moves Date.now()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { formatRemaining, useCountdown } from "./use-countdown";

describe("formatRemaining", () => {
  it("formats sub-minute durations as seconds only", () => {
    expect(formatRemaining(45_000)).toBe("45s");
    expect(formatRemaining(1_000)).toBe("1s");
  });

  it("formats durations of a minute or more as `Xm Ys`", () => {
    expect(formatRemaining(90_000)).toBe("1m 30s");
    expect(formatRemaining(125_000)).toBe("2m 5s");
  });

  it("rounds a partial trailing second up", () => {
    expect(formatRemaining(1_500)).toBe("2s");
  });
});

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the full remaining time before the first tick", () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt, false));
    expect(result.current).toBe(10_000);
  });

  it("ticks down toward the deadline as time advances", () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt, false));
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(7_000);
  });

  it("clamps to zero once past the deadline (never negative)", () => {
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt, false));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(0);
  });

  it("does not tick while stopped", () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt, true));
    const before = result.current;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(before);
  });
});
