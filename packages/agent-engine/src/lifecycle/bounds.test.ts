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
  TIMEOUT_MAX,
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

/**
 * A recording scheduler. Node's real `setTimeout` cannot be used to prove
 * anything about a 30-day ceiling, and vitest's fake timers do not reproduce
 * the 32-bit overflow that caused #1408 — they would happily schedule
 * 2_592_000_000 ms and the test would pass against the broken code. So the
 * assertion is on the delays the module *requests*: no single one may exceed
 * what Node can represent.
 */
function recordingScheduler() {
  const requested: number[] = [];
  const pending = new Map<number, () => void>();
  let nextId = 1;

  return {
    requested,
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      requested.push(ms);
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    /** Fire the most recently armed timer, as elapsing would. */
    fireLatest(): void {
      const id = Math.max(...pending.keys());
      const fn = pending.get(id);
      pending.delete(id);
      fn?.();
    },
    get armed(): number {
      return pending.size;
    },
  };
}

describe("startMaxLifetime past Node's TIMEOUT_MAX (#1408)", () => {
  it("never asks for a delay Node cannot represent", () => {
    const scheduler = recordingScheduler();
    startMaxLifetime({
      ms: 30 * 24 * 60 * 60 * 1000,
      onExpire: () => {},
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    expect(scheduler.requested).toHaveLength(1);
    expect(scheduler.requested[0]).toBeLessThanOrEqual(TIMEOUT_MAX);
  });

  it("bounds at the time asked for, by chaining the remainder", () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const scheduler = recordingScheduler();
    const onExpire = vi.fn();
    startMaxLifetime({
      ms: thirtyDays,
      onExpire,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    // First slice is a full TIMEOUT_MAX and does NOT expire the bound.
    expect(scheduler.requested).toEqual([TIMEOUT_MAX]);
    scheduler.fireLatest();
    expect(onExpire).not.toHaveBeenCalled();

    // Second slice is exactly the remainder, and that one expires it.
    expect(scheduler.requested).toEqual([
      TIMEOUT_MAX,
      thirtyDays - TIMEOUT_MAX,
    ]);
    scheduler.fireLatest();
    expect(onExpire).toHaveBeenCalledTimes(1);

    // The requested delays add up to the ceiling that was asked for.
    expect(scheduler.requested.reduce((a, b) => a + b, 0)).toBe(thirtyDays);
  });

  it("chains as many slices as the ceiling needs", () => {
    const scheduler = recordingScheduler();
    const onExpire = vi.fn();
    startMaxLifetime({
      ms: TIMEOUT_MAX * 2 + 5,
      onExpire,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    scheduler.fireLatest();
    scheduler.fireLatest();
    expect(onExpire).not.toHaveBeenCalled();
    scheduler.fireLatest();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(scheduler.requested).toEqual([TIMEOUT_MAX, TIMEOUT_MAX, 5]);
  });

  it("fires once at exactly TIMEOUT_MAX, with no chaining", () => {
    const scheduler = recordingScheduler();
    const onExpire = vi.fn();
    startMaxLifetime({
      ms: TIMEOUT_MAX,
      onExpire,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });
    expect(scheduler.requested).toEqual([TIMEOUT_MAX]);
    scheduler.fireLatest();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("stop() during an early slice cancels the whole chain", () => {
    const scheduler = recordingScheduler();
    const onExpire = vi.fn();
    const handle = startMaxLifetime({
      ms: TIMEOUT_MAX * 3,
      onExpire,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });

    scheduler.fireLatest();
    handle.stop();
    expect(scheduler.armed).toBe(0);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("still refuses Infinity rather than chaining forever", () => {
    const scheduler = recordingScheduler();
    startMaxLifetime({
      ms: Number.POSITIVE_INFINITY,
      onExpire: () => {},
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
    });
    expect(scheduler.requested).toEqual([]);
  });
});

/**
 * Every row of #1409's measured tables. `Number.parseInt` reported none of
 * these as invalid: it stops at the first character it cannot use and returns
 * the digits it already read.
 */
describe("bound resolvers reject partial parses (#1409)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const DEFAULT_MS = 3_600_000;

  it.each([
    ["30d", "a day suffix"],
    ["2h", "an hour suffix"],
    ["1e9", "exponent notation"],
    ["1_000_000", "digit separators"],
    ["0.5", "a decimal point"],
    ["abc", "no digits at all"],
    ["  12 34 ", "an interior space"],
    ["12,000", "a thousands separator"],
  ])("falls back to the default for %s (%s)", (raw) => {
    expect(resolveBoundMs("X_BOUND", DEFAULT_MS, { X_BOUND: raw })).toBe(
      DEFAULT_MS,
    );
  });

  it("cannot be disabled by 0.5 — the sentinel is 0, not a rounded-down 0.5", () => {
    expect(resolveBoundMs("MS_HALF", DEFAULT_MS, { MS_HALF: "0.5" })).toBe(
      DEFAULT_MS,
    );
  });

  it("still accepts the values that always worked", () => {
    expect(resolveBoundMs("MS_OK", DEFAULT_MS, { MS_OK: "900000" })).toBe(
      900_000,
    );
    expect(resolveBoundMs("MS_OFF", DEFAULT_MS, { MS_OFF: "off" })).toBe(0);
    expect(resolveBoundMs("MS_OFF2", DEFAULT_MS, { MS_OFF2: " OFF " })).toBe(0);
    expect(resolveBoundMs("MS_ZERO", DEFAULT_MS, { MS_ZERO: "0" })).toBe(0);
    expect(resolveBoundMs("MS_NEG", DEFAULT_MS, { MS_NEG: "-5" })).toBe(0);
    expect(resolveBoundMs("MS_ABSENT", DEFAULT_MS, {})).toBe(DEFAULT_MS);
  });

  it("reports a rejected value once, not on every call", () => {
    const env = { MS_NOISY: "30d" };
    resolveBoundMs("MS_NOISY", DEFAULT_MS, env);
    resolveBoundMs("MS_NOISY", DEFAULT_MS, env);
    resolveBoundMs("MS_NOISY", DEFAULT_MS, env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("MS_NOISY");
  });

  it("says nothing about an absent or empty variable", () => {
    resolveBoundMs("MS_UNSET", DEFAULT_MS, {});
    resolveBoundMs("MS_EMPTY", DEFAULT_MS, { MS_EMPTY: "" });
    expect(warn).not.toHaveBeenCalled();
  });

  const DEFAULT_BYTES = 512 * 1024 * 1024;

  it.each([
    ["2gb", "a gigabyte suffix"],
    ["1.5", "a decimal point"],
    ["1e3", "exponent notation"],
  ])("falls back for byte bound %s (%s)", (raw) => {
    expect(
      resolveBoundBytes("BYTES_BOUND", DEFAULT_BYTES, { BYTES_BOUND: raw }),
    ).toBe(DEFAULT_BYTES);
  });

  it("still reads a plain megabyte count", () => {
    expect(
      resolveBoundBytes("BYTES_OK", DEFAULT_BYTES, { BYTES_OK: "512" }),
    ).toBe(512 * 1024 * 1024);
    expect(
      resolveBoundBytes("BYTES_OFF", DEFAULT_BYTES, { BYTES_OFF: "off" }),
    ).toBe(0);
    expect(
      resolveBoundBytes("BYTES_ZERO", DEFAULT_BYTES, { BYTES_ZERO: "0" }),
    ).toBe(0);
  });

  it("refuses a megabyte count that leaves the safe integer range", () => {
    expect(
      resolveBoundBytes("BYTES_HUGE", DEFAULT_BYTES, {
        BYTES_HUGE: "99999999999999",
      }),
    ).toBe(DEFAULT_BYTES);
  });
});
