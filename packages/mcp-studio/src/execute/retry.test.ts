// retry.ts: the deadline, cancellation, and retry loop the Senders share.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANCELLED,
  Clock,
  MAX_ATTEMPTS,
  defaultBackoff,
  deadlineExceeded,
  retryAfterMs,
  sleep,
  stopError,
  withRetries,
  type Attempt,
} from "./retry";
import type { SendError } from "./sender";

const busy: SendError = { title: "Service unavailable", detail: "Try again.", status: 503 };

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("defaultBackoff", () => {
  it("doubles from 100 ms", () => {
    expect([1, 2, 3].map(defaultBackoff)).toEqual([100, 200, 400]);
  });
});

describe("errors", () => {
  it("names the deadline", () => {
    expect(deadlineExceeded(5000)).toEqual({
      title: "Deadline exceeded",
      detail: "The call did not finish within 5000 ms.",
      status: undefined,
    });
  });

  it("turns a stop into its error", () => {
    expect(stopError("cancelled", 30_000)).toBe(CANCELLED);
    expect(stopError("deadline", 30_000)).toEqual(deadlineExceeded(30_000));
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("Sun, 27 Sep 2026 08:00:00 GMT");

  it("reads seconds", () => {
    expect(retryAfterMs("3", now)).toBe(3000);
    expect(retryAfterMs(" 2 ", now)).toBe(2000);
  });

  it("reads an HTTP date, and waits 0 for one in the past", () => {
    expect(retryAfterMs("Sun, 27 Sep 2026 08:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("Sun, 27 Sep 2026 07:00:00 GMT", now)).toBe(0);
  });

  it("reads nothing from an absent or unreadable header", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
  });
});

describe("sleep", () => {
  it("resolves true after the wait", async () => {
    vi.useFakeTimers();
    const done = sleep(100, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe(true);
  });

  it("resolves false at once for a signal that already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).resolves.toBe(false);
  });

  it("resolves false when the signal aborts during the wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const done = sleep(60_000, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(done).resolves.toBe(false);
  });

  it("does not fire early for a wait past the timer limit", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    const done = sleep(2 ** 40, controller.signal).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    controller.abort();
    await expect(done).resolves.toBe(false);
  });
});

describe("Clock", () => {
  it("settles with the promise's value or error", async () => {
    const clock = new Clock(Date.now() + 60_000, new AbortController().signal, new AbortController());
    await expect(clock.race(Promise.resolve(5))).resolves.toEqual({ kind: "value", value: 5 });
    const error = new Error("reset");
    await expect(clock.race(Promise.reject(error))).resolves.toEqual({ kind: "failed", error });
    clock.dispose();
  });

  it("stops at the deadline and aborts the attempt", async () => {
    vi.useFakeTimers();
    const attempt = new AbortController();
    const clock = new Clock(Date.now() + 1000, new AbortController().signal, attempt);
    const raced = clock.race(never());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(raced).resolves.toEqual({ kind: "stopped", stop: "deadline" });
    expect(attempt.signal.aborted).toBe(true);
    clock.dispose();
  });

  it("stops when the caller cancels", async () => {
    const caller = new AbortController();
    const clock = new Clock(Date.now() + 60_000, caller.signal, new AbortController());
    const raced = clock.race(never());
    caller.abort();
    await expect(raced).resolves.toEqual({ kind: "stopped", stop: "cancelled" });
    clock.dispose();
  });

  it("stops at once for a signal that already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    const attempt = new AbortController();
    const clock = new Clock(Date.now() + 60_000, caller.signal, attempt);
    expect(attempt.signal.aborted).toBe(true);
    await expect(clock.race(Promise.resolve(1))).resolves.toEqual({ kind: "stopped", stop: "cancelled" });
    clock.dispose();
  });

  it("keeps the first stop, and stops every later race", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const clock = new Clock(Date.now() + 10, caller.signal, new AbortController());
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    await expect(clock.race(never())).resolves.toEqual({ kind: "stopped", stop: "deadline" });
    clock.dispose();
  });

  it("ignores a promise that settles after the stop", async () => {
    vi.useFakeTimers();
    let resolve: (value: number) => void = () => undefined;
    const late = new Promise<number>((settle) => {
      resolve = settle;
    });
    const clock = new Clock(Date.now() + 10, new AbortController().signal, new AbortController());
    const raced = clock.race(late);
    await vi.advanceTimersByTimeAsync(10);
    resolve(7);
    await expect(raced).resolves.toEqual({ kind: "stopped", stop: "deadline" });
    clock.dispose();
  });

  it("stops listening to the caller once disposed", () => {
    const caller = new AbortController();
    const attempt = new AbortController();
    const clock = new Clock(Date.now() + 60_000, caller.signal, attempt);
    clock.dispose();
    caller.abort();
    expect(attempt.signal.aborted).toBe(false);
  });
});

describe("withRetries", () => {
  function policy(overrides: Partial<{ deadline: number; signal: AbortSignal; backoff_ms: (retry: number) => number }> = {}) {
    return { deadline: Date.now() + 60_000, signal: new AbortController().signal, backoff_ms: () => 0, ...overrides };
  }

  it("returns the first success with its attempt count", async () => {
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: true, value: "done" }));
    await expect(withRetries(attempt, policy())).resolves.toEqual({ ok: true, value: "done", attempts: 1 });
  });

  it("returns a failure that carries no retry at once", async () => {
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: false, error: busy }));
    await expect(withRetries(attempt, policy())).resolves.toEqual({ ok: false, error: busy, attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries up to 3 times, then returns the last error", async () => {
    const attempt = vi.fn(
      async (number: number): Promise<Attempt<string>> => ({
        ok: false,
        error: { ...busy, detail: `attempt ${number}` },
        retry: { after_ms: undefined },
      }),
    );
    const result = await withRetries(attempt, policy());
    expect(result).toEqual({ ok: false, error: { ...busy, detail: "attempt 4" }, attempts: MAX_ATTEMPTS });
    expect(attempt.mock.calls.map(([number]) => number)).toEqual([1, 2, 3, 4]);
  });

  it("succeeds on a retry", async () => {
    const attempt = vi.fn(
      async (number: number): Promise<Attempt<string>> =>
        number < 3 ? { ok: false, error: busy, retry: { after_ms: undefined } } : { ok: true, value: "third" },
    );
    await expect(withRetries(attempt, policy())).resolves.toEqual({ ok: true, value: "third", attempts: 3 });
  });

  it("waits the backoff when the upstream names no wait", async () => {
    const backoff_ms = vi.fn(() => 0);
    const attempt = vi.fn(
      async (number: number): Promise<Attempt<string>> =>
        number === 1 ? { ok: false, error: busy, retry: { after_ms: undefined } } : { ok: true, value: "ok" },
    );
    await withRetries(attempt, policy({ backoff_ms }));
    expect(backoff_ms).toHaveBeenCalledWith(1);
  });

  it("waits the upstream's Retry-After in place of the backoff", async () => {
    vi.useFakeTimers();
    const backoff_ms = vi.fn(() => 0);
    const attempt = vi.fn(
      async (number: number): Promise<Attempt<string>> =>
        number === 1 ? { ok: false, error: busy, retry: { after_ms: 500 } } : { ok: true, value: "ok" },
    );
    const result = withRetries(attempt, policy({ backoff_ms }));
    await vi.advanceTimersByTimeAsync(499);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true, value: "ok", attempts: 2 });
    expect(backoff_ms).not.toHaveBeenCalled();
  });

  it("does not wait for a retry that would start past the deadline", async () => {
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: false, error: busy, retry: { after_ms: 5000 } }));
    const result = await withRetries(attempt, policy({ deadline: Date.now() + 1000 }));
    expect(result).toEqual({ ok: false, error: busy, attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("returns Cancelled when the caller cancels during the wait", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: false, error: busy, retry: { after_ms: 1000 } }));
    const result = withRetries(attempt, policy({ signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    await expect(result).resolves.toEqual({ ok: false, error: CANCELLED, attempts: 1 });
  });

  it("returns the last error when the wait ends past the deadline", async () => {
    // The first read is the check before the wait. The second, after it, lands past the deadline.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1_000);
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: false, error: busy, retry: { after_ms: 1 } }));
    const result = await withRetries(attempt, { deadline: 100, signal: new AbortController().signal, backoff_ms: () => 0 });
    expect(result).toEqual({ ok: false, error: busy, attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
