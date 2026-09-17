// rate-limit.test.ts
//
// Unit tests for the in-memory fixed-window rate limiter, exercised directly
// against a minimal fake Hono context so the whole suite stays fast and
// doesn't need a real app.

import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import { createFixedWindowCounter, rateLimiter } from "./rate-limit";
import type { AppEnv } from "../app";

function fakeContext(headers: Record<string, string> = {}): Context<AppEnv> {
  const responseHeaders: Record<string, string> = {};
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    json: vi.fn((body: unknown, status: number) => ({ body, status })),
    // Expose for assertions without widening the real Context type elsewhere.
    __responseHeaders: responseHeaders,
  } as unknown as Context<AppEnv>;
}

describe("rateLimiter", () => {
  it("allows requests under the limit", async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 2 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ "x-forwarded-for": "203.0.113.1" });

    const result1 = await middleware(c, next);
    const result2 = await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  it("rejects the request once the key exceeds max within the window", async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 2 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ "x-forwarded-for": "203.0.113.2" });

    await middleware(c, next);
    await middleware(c, next);
    const third = (await middleware(c, next)) as { status: number } | undefined;

    expect(next).toHaveBeenCalledTimes(2); // the 3rd call never reaches next()
    expect(third?.status).toBe(429);
  });

  it("sets a Retry-After header on a rejected request", async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ "x-forwarded-for": "203.0.113.3" });

    await middleware(c, next);
    await middleware(c, next);

    const responseHeaders = (
      c as unknown as { __responseHeaders: Record<string, string> }
    ).__responseHeaders;
    expect(responseHeaders["Retry-After"]).toBeDefined();
    expect(Number(responseHeaders["Retry-After"])).toBeGreaterThan(0);
  });

  it("tracks distinct keys independently", async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn().mockResolvedValue(undefined);
    const cA = fakeContext({ "x-forwarded-for": "203.0.113.4" });
    const cB = fakeContext({ "x-forwarded-for": "203.0.113.5" });

    await middleware(cA, next); // A's 1st — allowed
    const bFirst = await middleware(cB, next); // B's 1st — allowed, independent of A
    const aSecond = (await middleware(cA, next)) as
      | { status: number }
      | undefined; // A's 2nd — rejected

    expect(bFirst).toBeUndefined();
    expect(aSecond?.status).toBe(429);
  });

  it("resets the count once the window elapses", async () => {
    vi.useFakeTimers();
    try {
      const middleware = rateLimiter({ windowMs: 1_000, max: 1 });
      const next = vi.fn().mockResolvedValue(undefined);
      const c = fakeContext({ "x-forwarded-for": "203.0.113.6" });

      await middleware(c, next); // 1st — allowed
      const rejected = (await middleware(c, next)) as
        | { status: number }
        | undefined; // 2nd — rejected
      expect(rejected?.status).toBe(429);

      vi.advanceTimersByTime(1_001);
      const afterWindow = await middleware(c, next); // window elapsed — allowed again
      expect(afterWindow).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to x-real-ip, then "unknown", when x-forwarded-for is absent', async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn().mockResolvedValue(undefined);
    const withRealIp = fakeContext({ "x-real-ip": "203.0.113.7" });
    const withNoHeaders = fakeContext({});

    await middleware(withRealIp, next);
    await middleware(withNoHeaders, next);

    // Distinct keys ("203.0.113.7" vs "unknown") — neither should be rejected yet.
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("supports a custom keyFn instead of IP-based keying", async () => {
    const middleware = rateLimiter({
      windowMs: 60_000,
      max: 1,
      keyFn: () => "fixed-key",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(fakeContext({ "x-forwarded-for": "203.0.113.8" }), next);
    const rejected = (await middleware(
      fakeContext({ "x-forwarded-for": "203.0.113.9" }),
      next,
    )) as { status: number } | undefined;

    // Different IPs, same custom key — the second call is still rejected.
    expect(rejected?.status).toBe(429);
  });

  it("keeps working across a window roll without leaking the previous window's keys", async () => {
    vi.useFakeTimers();
    try {
      let keyCounter = 0;
      const middleware = rateLimiter({
        windowMs: 1_000,
        max: 1,
        keyFn: () => `k${keyCounter}`,
      });
      const next = vi.fn().mockResolvedValue(undefined);

      for (keyCounter = 0; keyCounter < 5_000; keyCounter++) {
        await middleware(fakeContext(), next);
      }
      vi.advanceTimersByTime(2_000);

      keyCounter = 999_999;
      expect(await middleware(fakeContext(), next)).toBeUndefined();
      const rejected = (await middleware(fakeContext(), next)) as
        | { status: number }
        | undefined;
      expect(rejected?.status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── createFixedWindowCounter: the bound ───────────────────────────────────────
//
// These are about memory, not about limits. The counter is fed by
// pre-authentication limiters, so the caller chooses its own keys and the bound
// has to hold WITHIN one window. The version this replaced swept only expired
// entries, which bounds the map across windows and not at all inside one — so a
// test that lets the window roll passes against the broken code and proves
// nothing. Every case here freezes the clock.

describe("createFixedWindowCounter", () => {
  it("bounds the tracked-key map inside a single window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      const counter = createFixedWindowCounter(60_000);

      // Far past the cap, all inside one window, nothing ever expiring — the
      // shape of a caller minting a fresh Authorization value per request.
      for (let i = 0; i < 25_000; i += 1) counter.hit(`credential:${i}`);

      expect(counter.size).toBeLessThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still counts correctly for a key that survives a flood", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      const counter = createFixedWindowCounter(60_000);

      for (let i = 0; i < 12_000; i += 1) counter.hit(`flood:${i}`);
      const first = counter.hit("survivor");
      const second = counter.hit("survivor");

      expect(first.count).toBe(1);
      expect(second.count).toBe(2);
      expect(second.resetAt).toBe(first.resetAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts a key that went quiet before one that is still active", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      const counter = createFixedWindowCounter(60_000);

      // `keeper` is seen first, so on a plain `Map.set` it would stay at the
      // front of the iteration order for ever and be the first thing evicted —
      // exactly the wrong key. Re-inserting on a window roll is what moves it
      // behind `quiet`.
      counter.hit("keeper");
      counter.hit("quiet");
      vi.advanceTimersByTime(120_000);
      counter.hit("keeper");

      // 9_999 fresh keys take the map to the cap and force exactly one
      // eviction, which must be `quiet`.
      for (let i = 0; i < 9_999; i += 1) counter.hit(`flood:${i}`);

      expect(counter.size).toBe(10_000);
      expect(counter.hit("keeper").count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors the window to the epoch, not to the key's first hit", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:30.000Z"));
      const counter = createFixedWindowCounter(60_000);
      expect(counter.hit("k").resetAt).toBe(
        new Date("2026-09-17T12:01:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
