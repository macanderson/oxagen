/**
 * Lifecycle bounds tests — fake timers throughout (repo rule: never fixed
 * sleeps). The rss reader is injected so no test depends on real memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startMaxLifetime,
  startRssWatchdog,
  resolveBoundMs,
  resolveBoundBytes,
} from "./bounds";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startMaxLifetime", () => {
  it("fires onExpire exactly once when the ceiling elapses", () => {
    const onExpire = vi.fn();
    startMaxLifetime({ ms: 1000, onExpire });
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("never fires after stop()", () => {
    const onExpire = vi.fn();
    const handle = startMaxLifetime({ ms: 1000, onExpire });
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("stop() is idempotent and safe after firing", () => {
    const onExpire = vi.fn();
    const handle = startMaxLifetime({ ms: 10, onExpire });
    vi.advanceTimersByTime(10);
    expect(onExpire).toHaveBeenCalledTimes(1);
    handle.stop();
    handle.stop();
  });

  it("a non-positive or non-finite ceiling disables the bound", () => {
    const onExpire = vi.fn();
    startMaxLifetime({ ms: 0, onExpire });
    startMaxLifetime({ ms: -5, onExpire });
    startMaxLifetime({ ms: Number.NaN, onExpire });
    startMaxLifetime({ ms: Number.POSITIVE_INFINITY, onExpire });
    vi.advanceTimersByTime(1_000_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("startRssWatchdog", () => {
  it("warns once at warnRatio and aborts once at the ceiling", () => {
    const onWarn = vi.fn();
    const onLimit = vi.fn();
    let rss = 100;
    startRssWatchdog({
      maxRssBytes: 1000,
      intervalMs: 100,
      onWarn,
      onLimit,
      readRss: () => rss,
    });

    vi.advanceTimersByTime(100);
    expect(onWarn).not.toHaveBeenCalled();

    rss = 850; // ≥ 80% of 1000
    vi.advanceTimersByTime(100);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(850, 1000);
    expect(onLimit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300); // still above warn — must not re-warn
    expect(onWarn).toHaveBeenCalledTimes(1);

    rss = 1000;
    vi.advanceTimersByTime(100);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledWith(1000, 1000);

    // Watchdog stopped itself: further ticks never re-fire.
    vi.advanceTimersByTime(1000);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("stop() halts sampling", () => {
    const onLimit = vi.fn();
    const handle = startRssWatchdog({
      maxRssBytes: 1000,
      intervalMs: 100,
      onLimit,
      readRss: () => 5000,
    });
    handle.stop();
    vi.advanceTimersByTime(1000);
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("a failing rss reader is tolerated, never fatal", () => {
    const onLimit = vi.fn();
    startRssWatchdog({
      maxRssBytes: 1000,
      intervalMs: 100,
      onLimit,
      readRss: () => {
        throw new Error("boom");
      },
    });
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("a non-positive ceiling disables the watchdog", () => {
    const onLimit = vi.fn();
    startRssWatchdog({
      maxRssBytes: 0,
      intervalMs: 100,
      onLimit,
      readRss: () => 1,
    });
    vi.advanceTimersByTime(1000);
    expect(onLimit).not.toHaveBeenCalled();
  });
});

describe("resolveBoundMs", () => {
  it("falls back to the default when absent or unparsable", () => {
    expect(resolveBoundMs("X", 500, {})).toBe(500);
    expect(resolveBoundMs("X", 500, { X: "abc" })).toBe(500);
  });

  it("parses an integer override", () => {
    expect(resolveBoundMs("X", 500, { X: "1234" })).toBe(1234);
  });

  it("0, negative, or 'off' disables (returns 0)", () => {
    expect(resolveBoundMs("X", 500, { X: "0" })).toBe(0);
    expect(resolveBoundMs("X", 500, { X: "-1" })).toBe(0);
    expect(resolveBoundMs("X", 500, { X: "off" })).toBe(0);
    expect(resolveBoundMs("X", 500, { X: " OFF " })).toBe(0);
  });
});

describe("resolveBoundBytes", () => {
  it("interprets the env value as megabytes", () => {
    expect(resolveBoundBytes("X", 999, { X: "2048" })).toBe(2048 * 1024 * 1024);
  });

  it("falls back to the default (bytes) when absent or unparsable", () => {
    expect(resolveBoundBytes("X", 999, {})).toBe(999);
    expect(resolveBoundBytes("X", 999, { X: "lots" })).toBe(999);
  });

  it("0 or 'off' disables", () => {
    expect(resolveBoundBytes("X", 999, { X: "0" })).toBe(0);
    expect(resolveBoundBytes("X", 999, { X: "off" })).toBe(0);
  });
});
