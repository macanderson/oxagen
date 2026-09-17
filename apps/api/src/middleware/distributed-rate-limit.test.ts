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

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { logger } from "./logger";
import {
  authorizationFingerprintBucketKey,
  enrolledMachineBucketKey,
  distributedRateLimiter,
  deriveBucketKey,
  rateLimitBudgets,
  trustedVercelIpBucketKey,
} from "./distributed-rate-limit";

type FakeContextOpts = {
  method?: string;
  vars?: Partial<{ workspaceId: string; orgId: string; apiKeyId: string }>;
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
    expect(deriveBucketKey(c, "chat")).toBe("chat:ip:203.0.113.7");
  });

  it('uses x-real-ip, then "unknown", when x-forwarded-for is absent', () => {
    expect(
      deriveBucketKey(
        fakeContext({ headers: { "x-real-ip": "198.51.100.9" } }),
        "stella-telemetry",
      ),
    ).toBe("stella-telemetry:ip:198.51.100.9");
    expect(deriveBucketKey(fakeContext(), "stella-telemetry")).toBe(
      "stella-telemetry:ip:unknown",
    );
  });
});

describe("distributedRateLimiter", () => {
  it("counts every HTTP method when explicitly configured for all methods", async () => {
    scriptCount(1);
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 60,
      methods: "all",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(fakeContext({ method: "GET" }), next);

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("fails closed without calling next when the counter store is unavailable", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 60,
      failClosedOnStoreError: true,
    });
    const next = vi.fn().mockResolvedValue(undefined);

    const result = (await mw(fakeContext(), next)) as
      | { body: unknown; status: number }
      | undefined;

    expect(result?.status).toBe(503);
    expect(result?.body).toEqual({ error: "rate_limit_unavailable" });
    expect(next).not.toHaveBeenCalled();
  });

  it("serves an exhausted bucket from a local deny cache without another store write", async () => {
    scriptCount(61);
    const mw = distributedRateLimiter({ keyPrefix: "preauth", max: 60 });
    const next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext({ headers: { "x-forwarded-for": "203.0.113.9" } });

    const first = (await mw(c, next)) as { status: number } | undefined;
    const second = (await mw(c, next)) as { status: number } | undefined;

    expect(first?.status).toBe(429);
    expect(second?.status).toBe(429);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

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
    mocks.requireEnv.mockReturnValue({ RATE_LIMIT_CHAT_PER_MIN: 90 });

    const first = rateLimitBudgets();
    expect(first).toEqual({ chat: 90 });

    // Second call returns the SAME cached object without re-reading env — the
    // memoization that keeps app import from tripping env access at module load.
    const second = rateLimitBudgets();
    expect(second).toBe(first);
    expect(mocks.requireEnv).toHaveBeenCalledTimes(1);
  });
});

describe("driver parameter binding", () => {
  // Regression for the outage in which every enrolled Tacho host got
  // 503 `rate_limit_unavailable`. Both statements interpolated a JS `Date`
  // into a raw `sql` template. drizzle only converts a Date when the statement
  // is built from a typed column, so the Date reached postgres.js verbatim,
  // whose Bind path calls `Buffer.byteLength(value)` and throws
  // ERR_INVALID_ARG_TYPE for anything that is not a string or Buffer. The
  // limiter therefore threw on EVERY request and had never written a counter:
  // fail-open surfaces stopped limiting silently and fail-closed pre-auth
  // ceilings answered 503.
  //
  // The scripted `execute` in these tests accepts any argument, which is why
  // CI stayed green through it. So assert on the parameters drizzle would
  // actually hand the driver, by compiling the SQL through the real dialect.
  function compileParams(sqlChunk: unknown): unknown[] {
    return new PgDialect().sqlToQuery(sqlChunk as SQL).params;
  }

  /** Every param must be something postgres.js can serialize (never a Date). */
  function expectDriverSerializable(params: readonly unknown[]): void {
    for (const param of params) {
      expect(param).not.toBeInstanceOf(Date);
      expect(["string", "number", "boolean"]).toContain(typeof param);
    }
  }

  it("binds the counter window as a string, not a Date", async () => {
    const executed: unknown[] = [];
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: vi.fn(async (chunk: unknown) => {
            executed.push(chunk);
            return [{ count: 1 }];
          }),
        }),
    );

    const next = vi.fn();
    await distributedRateLimiter({ keyPrefix: "probe", max: 10 })(
      fakeContext(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(executed).toHaveLength(1);
    const params = compileParams(executed[0]);
    // bucket_key, then the window — both text by the time the driver sees them.
    expect(params).toHaveLength(2);
    expect(params[0]).toBe("probe:ip:unknown");
    expect(typeof params[1]).toBe("string");
    expect(Date.parse(params[1] as string)).not.toBeNaN();
    expectDriverSerializable(params);
  });

  it("binds the stale-window sweep cutoff as a string, not a Date", async () => {
    // Force the 1%-sampled opportunistic sweep to fire.
    vi.spyOn(Math, "random").mockReturnValue(0);

    const executed: unknown[] = [];
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: vi.fn(async (chunk: unknown) => {
            executed.push(chunk);
            return [{ count: 1 }];
          }),
        }),
    );

    await distributedRateLimiter({ keyPrefix: "probe", max: 10 })(
      fakeContext(),
      vi.fn(),
    );

    // The increment, then the sweep in its own transaction.
    expect(executed).toHaveLength(2);
    const sweepParams = compileParams(executed[1]);
    expect(sweepParams).toHaveLength(1);
    expect(typeof sweepParams[0]).toBe("string");
    expectDriverSerializable(sweepParams);
  });
});

describe("store-error logging", () => {
  // The outage above was hard to diagnose because the warn logged
  // `err.message` only, and drizzle's DrizzleQueryError message is just the SQL
  // text — the real TypeError sat in `cause` and never reached CloudWatch.
  it("logs the whole cause chain, not just the wrapper's message", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const wrapped = new Error("Failed query: INSERT ...", {
      cause: new TypeError('The "string" argument must be of type string'),
    });
    mocks.withSystemDb.mockRejectedValue(wrapped);

    const next = vi.fn();
    await distributedRateLimiter({ keyPrefix: "probe", max: 10 })(
      fakeContext(),
      next,
    );

    expect(next).toHaveBeenCalledOnce(); // fail-open default
    expect(warn).toHaveBeenCalledOnce();
    const logged = (warn.mock.calls[0]?.[0] as { err: string }).err;
    expect(logged).toContain("Failed query");
    expect(logged).toContain('The "string" argument must be of type string');
  });
});

describe("enrolled-machine bucket key", () => {
  // The post-auth Tacho and Stella ceilings are sized per host, but they used
  // the default derivation, which keys on workspaceId — so every host enrolled
  // into one workspace shared a single 30/min counter and they would all have
  // hit 429 together the moment these counters started working.
  it("gives each enrolled credential its own bucket within one workspace", () => {
    const hostA = enrolledMachineBucketKey(
      fakeContext({ vars: { apiKeyId: "key-a", workspaceId: "ws-1" } }),
    );
    const hostB = enrolledMachineBucketKey(
      fakeContext({ vars: { apiKeyId: "key-b", workspaceId: "ws-1" } }),
    );

    expect(hostA).toBe("machine:key-a");
    expect(hostB).toBe("machine:key-b");
    expect(hostA).not.toBe(hostB);
  });

  it("prefers the credential over the workspace it is scoped to", () => {
    expect(
      enrolledMachineBucketKey(
        fakeContext({ vars: { apiKeyId: "key-a", workspaceId: "ws-1" } }),
      ),
    ).not.toContain("ws-1");
  });

  it("falls back to the previous workspace derivation without an API key", () => {
    expect(
      enrolledMachineBucketKey(fakeContext({ vars: { workspaceId: "ws-1" } })),
    ).toBe("ws:ws-1");
    expect(
      enrolledMachineBucketKey(fakeContext({ vars: { orgId: "org-1" } })),
    ).toBe("org:org-1");
    expect(enrolledMachineBucketKey(fakeContext())).toBe("ip:unknown");
  });
});
