// distributed-rate-limit.test.ts
//
// Unit tests for the Postgres-backed distributed rate limiter. Only
// withSystemDb is mocked (spread over the real @oxagen/database so sibling
// exports survive — full-replacement would drop them); it invokes the
// middleware's callback against a scripted fake tx whose execute() resolves to
// a queued { count } row. This exercises the real increment / 429 / fail-open /
// key-derivation branches without a live database, so it runs in CI.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import type { AppEnv } from "../app";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  requireEnv: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return { ...actual, withSystemDb: mocks.withSystemDb };
});

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/config/env")>();
  return { ...actual, requireEnv: mocks.requireEnv };
});

import {
  authorizationFingerprintBucketKey,
  distributedRateLimiter,
  deriveBucketKey,
  rateLimitBudgets,
  trustedVercelIpBucketKey,
} from "./distributed-rate-limit";

type FakeContextOpts = {
  method?: string;
  vars?: Partial<{ workspaceId: string; orgId: string }>;
  headers?: Record<string, string>;
};

function fakeContext(opts: FakeContextOpts = {}): Context<AppEnv> {
  const vars = (opts.vars ?? {}) as Record<string, unknown>;
  const responseHeaders: Record<string, string> = {};
  return {
    req: {
      method: opts.method ?? "POST",
      header: (name: string) => opts.headers?.[name.toLowerCase()],
    },
    get: (key: string) => vars[key] ?? null,
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    json: vi.fn((body: unknown, status: number) => ({ body, status })),
    // Exposed for assertions without widening the real Context type.
    __responseHeaders: responseHeaders,
  } as unknown as Context<AppEnv>;
}

function responseHeadersOf(c: Context<AppEnv>): Record<string, string> {
  return (c as unknown as { __responseHeaders: Record<string, string> })
    .__responseHeaders;
}

/** Make withSystemDb run the middleware's callback against a tx returning `count`. */
function scriptCount(count: number): void {
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: vi.fn().mockResolvedValue([{ count }]) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Keep the opportunistic cleanup (Math.random < 0.01) from firing so
  // withSystemDb is called exactly once per counted request.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pre-authentication bucket keys", () => {
  it("collapses all off-Vercel IP headers into one unverified bucket", () => {
    vi.stubEnv("VERCEL", "");

    expect(
      trustedVercelIpBucketKey(
        fakeContext({
          headers: {
            "x-forwarded-for": "198.51.100.1",
            "x-vercel-forwarded-for": "203.0.113.1",
          },
        }),
      ),
    ).toBe("ip:unverified");
    expect(
      trustedVercelIpBucketKey(
        fakeContext({
          headers: {
            "x-forwarded-for": "198.51.100.2",
            "x-vercel-forwarded-for": "203.0.113.2",
          },
        }),
      ),
    ).toBe("ip:unverified");
  });

  it("normalizes a bearer credential and returns only a SHA-256 fingerprint", () => {
    const compact = authorizationFingerprintBucketKey(
      fakeContext({ headers: { authorization: "Bearer secret-key" } }),
    );
    const padded = authorizationFingerprintBucketKey(
      fakeContext({ headers: { authorization: "Bearer   secret-key  " } }),
    );

    expect(compact).toBe(padded);
    expect(compact).toMatch(/^credential:[a-f0-9]{64}$/);
    expect(compact).not.toContain("secret-key");
  });
});

describe("deriveBucketKey", () => {
  it("prefers workspace scope when a workspaceId is present", () => {
    const c = fakeContext({ vars: { workspaceId: "ws_1", orgId: "org_1" } });
    expect(deriveBucketKey(c, "chat")).toBe("chat:ws:ws_1");
  });

  it("falls back to org scope when there is no workspaceId", () => {
    const c = fakeContext({ vars: { orgId: "org_1" } });
    expect(deriveBucketKey(c, "chat")).toBe("chat:org:org_1");
  });

  it("falls back to the client IP when neither workspace nor org is set", () => {
    const c = fakeContext({
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(deriveBucketKey(c, "agent")).toBe("agent:ip:203.0.113.7");
  });

  it('uses x-real-ip, then "unknown", when x-forwarded-for is absent', () => {
    expect(
      deriveBucketKey(
        fakeContext({ headers: { "x-real-ip": "198.51.100.9" } }),
        "a2a",
      ),
    ).toBe("a2a:ip:198.51.100.9");
    expect(deriveBucketKey(fakeContext(), "a2a")).toBe("a2a:ip:unknown");
  });
});

describe("distributedRateLimiter", () => {
  it("uses a custom bucket-key resolver without trusting the default client IP", async () => {
    let observedKey: unknown;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: vi.fn().mockImplementation(async (query: unknown) => {
            observedKey = (
              query as { queryChunks?: unknown[] }
            ).queryChunks?.at(1);
            return [{ count: 1 }];
          }),
        }),
    );
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 60,
      bucketKey: () => "credential:sha256",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(
      fakeContext({ headers: { "x-forwarded-for": "spoofed.example" } }),
      next,
    );

    expect(observedKey).toBe("preauth:credential:sha256");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("increments the window and sets X-RateLimit headers when under the limit", async () => {
    scriptCount(1);
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 60 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ vars: { workspaceId: "ws_1" } });

    const result = await mw(c, next);

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    const headers = responseHeadersOf(c);
    expect(headers["X-RateLimit-Limit"]).toBe("60");
    expect(headers["X-RateLimit-Remaining"]).toBe("59");
    expect(Number(headers["X-RateLimit-Reset"])).toBeGreaterThan(0);
  });

  it("rejects with 429 + Retry-After once the count exceeds max", async () => {
    scriptCount(61); // one past a max of 60
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 60 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ vars: { workspaceId: "ws_1" } });

    const result = (await mw(c, next)) as
      | { body: unknown; status: number }
      | undefined;

    expect(next).not.toHaveBeenCalled();
    expect(result?.status).toBe(429);
    expect(result?.body).toEqual({ error: "rate_limited" });
    const headers = responseHeadersOf(c);
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
  });

  it("allows exactly `max` requests before rejecting the next", async () => {
    const mw = distributedRateLimiter({ keyPrefix: "agent", max: 30 });
    const next = vi.fn().mockResolvedValue(undefined);

    scriptCount(30); // the 30th request — still allowed (remaining 0)
    const c30 = fakeContext({ vars: { orgId: "org_1" } });
    const atLimit = await mw(c30, next);
    expect(atLimit).toBeUndefined();
    expect(responseHeadersOf(c30)["X-RateLimit-Remaining"]).toBe("0");

    scriptCount(31); // the 31st — rejected
    const over = (await mw(fakeContext({ vars: { orgId: "org_1" } }), next)) as
      | { status: number }
      | undefined;
    expect(over?.status).toBe(429);
  });

  it("FAILS OPEN — a store error allows the request instead of throwing", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unreachable"));
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 60 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ vars: { workspaceId: "ws_1" } });

    const result = await mw(c, next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1); // request allowed despite the store failure
  });

  it("does not count (or touch the store for) methods outside the limited set", async () => {
    scriptCount(1);
    const mw = distributedRateLimiter({ keyPrefix: "agent", max: 30 }); // default: POST only
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ method: "GET", vars: { workspaceId: "ws_1" } });

    const result = await mw(c, next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(responseHeadersOf(c)["X-RateLimit-Limit"]).toBeUndefined();
  });

  it("resolves a lazy `max` resolver on each request (function form)", async () => {
    scriptCount(1);
    const maxResolver = vi.fn(() => 60);
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: maxResolver });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ vars: { workspaceId: "ws_lazy" } });

    await mw(c, next);

    expect(maxResolver).toHaveBeenCalledTimes(1);
    expect(responseHeadersOf(c)["X-RateLimit-Limit"]).toBe("60");
  });

  it("fires the opportunistic stale-window sweep when the sample roll wins", async () => {
    // Force the CLEANUP_SAMPLE_RATE (0.01) roll to win so the sweep path runs:
    // the increment upsert AND the DELETE sweep both hit the (mocked) store.
    vi.spyOn(Math, "random").mockReturnValue(0.001);
    scriptCount(1);
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 60 });
    const next = vi.fn().mockResolvedValue(undefined);

    const result = await mw(
      fakeContext({ vars: { workspaceId: "ws_sweep" } }),
      next,
    );

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    // Two store touches: the counter upsert plus the fire-and-forget sweep.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });
});

describe("rateLimitBudgets", () => {
  // rateLimitBudgets() memoizes into a module-level cache on first call, so
  // every test in this suite observes whichever env won the race to call it
  // first — assert the memoization contract itself (same instance, one
  // requireEnv call) rather than re-asserting specific values per call.
  it("resolves the budgets from the validated env once, then memoizes the result", () => {
    mocks.requireEnv.mockReturnValue({
      RATE_LIMIT_CHAT_PER_MIN: 90,
      RATE_LIMIT_AGENT_EXEC_PER_MIN: 45,
    });

    const first = rateLimitBudgets();
    expect(first).toEqual({ chat: 90, agentExec: 45 });

    // Second call returns the SAME cached object without re-reading env — the
    // memoization that keeps app import from tripping env access at module load.
    const second = rateLimitBudgets();
    expect(second).toBe(first);
    expect(mocks.requireEnv).toHaveBeenCalledTimes(1);
  });
});
