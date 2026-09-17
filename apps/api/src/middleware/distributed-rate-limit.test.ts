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
  trustedClientIpBucketKey,
  __resetRateLimitEnvForTests,
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
  // Both the edge-header gate and the trusted-proxy list are memoized on first
  // read, in this file and in lib/context.ts. Dropping both per case is how a
  // test that names proxies stops changing how the next one attributes an
  // address — that memo outliving a case is a green run for the wrong reason.
  __resetRateLimitEnvForTests();
  // Most cases here model the deployment AFTER the edge is in place and the
  // operator has turned the flag on, because that is the state the per-address
  // bucketing is for. The gate-off and no-proxies-named states have their own
  // cases below.
  mocks.requireEnv.mockReturnValue({
    TRUST_EDGE_CLIENT_IP_HEADER: true,
    TRUSTED_PROXY_CIDRS: "",
    RATE_LIMIT_CHAT_PER_MIN: 60,
  });
  // Keep the opportunistic cleanup (Math.random < 0.01) from firing so
  // withSystemDb is called exactly once per counted request.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pre-authentication bucket keys", () => {
  // The regression #3167 is named for: off Vercel this returned the constant
  // "ip:unverified" for every caller, so the whole internet shared one bucket
  // and one Postgres row. On a mount that runs before any credential exists
  // that is not a ceiling — it hands anyone who can reach the host the power to
  // take the entire Tacho and Stella ingress offline with `max + 1` requests.
  // Two callers must never share a bucket, and where no client can be
  // identified the limiter must SKIP rather than pool.
  //
  // Two declarations can name a caller: the proxies named in
  // TRUSTED_PROXY_CIDRS, and the edge header once its gate is on (ADR-083).
  // A hop count names nobody here, deliberately — see trustedClientIpBucketKey.
  it("gives two off-Vercel callers two different buckets", () => {
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      TRUSTED_PROXY_HOP_COUNT: 1,
    });

    // The trailing entry is the named proxy: an address is only attributable
    // when a trusted proxy wrote it.
    const first = trustedClientIpBucketKey(
      fakeContext({ headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.5" } }),
    );
    const second = trustedClientIpBucketKey(
      fakeContext({ headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.5" } }),
    );

    expect(first).toBe("ip:198.51.100.1");
    expect(second).toBe("ip:198.51.100.2");
    expect(first).not.toBe(second);
  });

  it("stops at the first entry that is not a trusted proxy, whatever the caller prepends", () => {
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      TRUSTED_PROXY_HOP_COUNT: 2,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: {
            // A caller prepending entries only lengthens a prefix the walk
            // never reaches: it stops on what an entry IS, not on how many.
            "x-forwarded-for": "evil, 10.9.9.9, 198.51.100.7, 10.0.0.5",
          },
        }),
      ),
    ).toBe("ip:198.51.100.7");
  });

  it("refuses a chain that no trusted proxy vouched for", () => {
    // No named proxy stands to the right of the rightmost entry, so nothing
    // wrote it but the caller — a typo in the CIDR list, a network change, or
    // a path that bypasses the proxy all look like this.
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      TRUSTED_PROXY_HOP_COUNT: 1,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-forwarded-for": "198.51.100.1" } }),
      ),
    ).toBeNull();
    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: { "x-forwarded-for": "10.0.0.5, 198.51.100.1" },
        }),
      ),
    ).toBeNull();
  });

  it("refuses to enforce a ceiling whose proxies the deployment has not named", () => {
    // A hop count is not enough on this mount: one that is too high lets a
    // caller pad x-forwarded-for until the arithmetic lands on a value the
    // caller chose, which means a fresh bucket per request and no ceiling at
    // all. Undeclared proxies are an unattributable request.
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUSTED_PROXY_CIDRS: "",
      TRUSTED_PROXY_HOP_COUNT: 1,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-forwarded-for": "198.51.100.1" } }),
      ),
    ).toBeNull();
  });

  it("returns null when no trusted proxy chain can be read", () => {
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUSTED_PROXY_CIDRS: "",
      TRUSTED_PROXY_HOP_COUNT: 0,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-forwarded-for": "198.51.100.1" } }),
      ),
    ).toBeNull();
    // Including x-real-ip, which on a zero-trusted-proxy deployment is just as
    // caller-supplied. Believing it would let a credential-stuffing client mint
    // a fresh bucket per request by rotating the header, evading this ceiling
    // entirely rather than being slowed by it.
    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-real-ip": "198.51.100.1" } }),
      ),
    ).toBeNull();
  });

  // ── the edge header (ADR-083) ────────────────────────────────────────────
  // The second way a caller can be named here. Caddy SETS x-oxagen-client-ip
  // with `header_up`, which REPLACES a copy the caller sent, so the value is
  // the edge's own — but only once the operator has turned the gate on, which
  // is the default state of these cases.

  it("gives each edge-reported client address its own bucket off Vercel", () => {
    vi.stubEnv("VERCEL", "");

    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.1" } }),
      ),
    ).toBe("ip:198.51.100.1");
    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "2001:db8::1" } }),
      ),
    ).toBe("ip:2001:db8::1");
  });

  it("prefers the edge-written address over the named-proxy walk", () => {
    // Both declarations are in force. The edge header is the one the deployment
    // writes itself, so it wins, and the two must never disagree about which
    // caller a bucket belongs to.
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUST_EDGE_CLIENT_IP_HEADER: true,
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      TRUSTED_PROXY_HOP_COUNT: 1,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: {
            "x-oxagen-client-ip": "198.51.100.1",
            "x-forwarded-for": "203.0.113.9, 10.0.0.5",
          },
        }),
      ),
    ).toBe("ip:198.51.100.1");
  });

  it("ignores the caller-writable forwarding headers off Vercel", () => {
    vi.stubEnv("VERCEL", "");

    // Only the edge header is written by a proxy that replaces a caller's copy.
    // x-forwarded-for is appended to by both the ALB and Caddy and names no
    // trusted proxy here, and x-real-ip is set by neither.
    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: {
            "x-oxagen-client-ip": "198.51.100.1",
            "x-forwarded-for": "203.0.113.9",
            "x-real-ip": "203.0.113.8",
            "x-vercel-forwarded-for": "203.0.113.7",
          },
        }),
      ),
    ).toBe("ip:198.51.100.1");
    // And with no edge header and no named proxies, nothing names the caller,
    // so the ceiling skips rather than pooling every caller into one bucket.
    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: {
            "x-forwarded-for": "203.0.113.9",
            "x-real-ip": "203.0.113.8",
          },
        }),
      ),
    ).toBeNull();
  });

  it("does not believe the edge header before the gate is turned on", () => {
    // Before the Caddy config lands, the OLD Caddyfile has no rule for this
    // header name and forwards a caller's copy unchanged. Trusting it on sight
    // would hand a caller a by-name route into a bucket key of its choosing.
    vi.stubEnv("VERCEL", "");
    mocks.requireEnv.mockReturnValue({
      TRUST_EDGE_CLIENT_IP_HEADER: false,
      TRUSTED_PROXY_CIDRS: "",
      TRUSTED_PROXY_HOP_COUNT: 1,
    });

    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.1" } }),
      ),
    ).toBeNull();
  });

  it("skips rather than bucketing anything that is not an address", () => {
    vi.stubEnv("VERCEL", "");

    for (const value of [
      "not-an-ip",
      "198.51.100.1, 203.0.113.9",
      " ",
      "f".repeat(46),
    ]) {
      expect(
        trustedClientIpBucketKey(
          fakeContext({ headers: { "x-oxagen-client-ip": value } }),
        ),
      ).toBeNull();
    }
  });

  it("trusts only Vercel's own header when running on Vercel", () => {
    vi.stubEnv("VERCEL", "1");

    // There is no Caddy in front of a Vercel deployment, so an edge header
    // arriving there came from the caller and must not be believed.
    expect(
      trustedClientIpBucketKey(
        fakeContext({
          headers: {
            "x-vercel-forwarded-for": "203.0.113.1, 10.0.0.1",
            "x-oxagen-client-ip": "198.51.100.1",
          },
        }),
      ),
    ).toBe("ip:203.0.113.1");
    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.1" } }),
      ),
    ).toBeNull();
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

// The #3183 second P1. The edge header is believed only because Caddy SETS it,
// and Caddy's config deploys through the infra pipeline while this code deploys
// through the application one. In the skew window the old Caddyfile has no rule
// for that header name and forwards a caller-supplied copy unchanged.
//
// What these cases have to discriminate: an implementation that reads the
// header whenever it is present passes every assertion above, because every
// assertion above is about a header that is genuinely from the edge. So here
// the header is forged, the flag is off, and the assertion is that the forged
// value does NOT become a bucket of its own.
describe("pre-authentication bucket keys with the edge header ungated", () => {
  beforeEach(() => {
    __resetRateLimitEnvForTests();
    mocks.requireEnv.mockReturnValue({
      TRUST_EDGE_CLIENT_IP_HEADER: false,
      TRUSTED_PROXY_CIDRS: "",
      RATE_LIMIT_CHAT_PER_MIN: 60,
    });
  });

  it("does not let a forged edge header mint its own bucket", () => {
    vi.stubEnv("VERCEL", "");

    // Two callers, two forged addresses, and no bucket for either: nothing the
    // deployment wrote names them, so the ceiling skips. It must not be one
    // shared bucket either — on a pre-authentication mount that is one caller's
    // power to deny the ingress to all the others.
    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.1" } }),
      ),
    ).toBeNull();
    expect(
      trustedClientIpBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.2" } }),
      ),
    ).toBeNull();
  });

  it("keeps the forged header out of the deriveBucketKey fallback too", () => {
    vi.stubEnv("VERCEL", "");

    expect(
      deriveBucketKey(
        fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.1" } }),
        "chat",
      ),
    ).toBe("chat:ip:unknown");
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

  it("falls back to the edge-reported client IP when neither workspace nor org is set", () => {
    const c = fakeContext({
      headers: { "x-oxagen-client-ip": "203.0.113.7" },
    });
    expect(deriveBucketKey(c, "chat")).toBe("chat:ip:203.0.113.7");
  });

  // #3183 P1, one layer down from the pre-auth buckets: this fallback read the
  // leftmost x-forwarded-for entry and then x-real-ip, so a caller could mint
  // an unbounded number of buckets by varying a header it writes itself.
  it("ignores the caller-writable headers and collapses to one bucket instead", () => {
    expect(
      deriveBucketKey(
        fakeContext({
          headers: {
            "x-forwarded-for": "203.0.113.7, 10.0.0.1",
            "x-real-ip": "198.51.100.9",
          },
        }),
        "stella-telemetry",
      ),
    ).toBe("stella-telemetry:ip:unknown");
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

  // ADR-082. The four pre-auth mounts used to answer 503 here, which is what
  // took Tacho and Stella intake offline in #3167.
  it("serves the request from the per-instance limiter when the counter store is unavailable", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 60,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    const result = await mw(
      fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.30" } }),
      next,
    );

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("still enforces a ceiling, per instance, while the counter store is unavailable", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 2,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.31" };

    await mw(fakeContext({ headers }), next);
    await mw(fakeContext({ headers }), next);
    const third = (await mw(fakeContext({ headers }), next)) as
      | { body: unknown; status: number }
      | undefined;

    expect(next).toHaveBeenCalledTimes(2);
    expect(third?.status).toBe(429);
    expect(third?.body).toMatchObject({ error: "rate_limited" });
  });

  it("keeps the degraded ceiling per bucket, not per limiter", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 1,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(
      fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.32" } }),
      next,
    );
    const otherCaller = await mw(
      fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.33" } }),
      next,
    );

    expect(otherCaller).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });

  // #3183 P2. A store that flaps sends some requests down the success path and
  // some down the failure path. While only the failures were counted locally, a
  // caller could spend `max` through Postgres and another `max` through the
  // degraded counter inside one window — 2 x max exactly when the store is
  // least reliable, which is not the bound ADR-082 states.
  it("does not hand a second full allowance out when the store flaps mid-window", async () => {
    let storeUp = true;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        if (!storeUp) throw new Error("db unavailable");
        return fn({
          execute: vi.fn().mockResolvedValue([{ count: served + 1 }]),
        });
      },
    );
    let served = 0;
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 2,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockImplementation(async () => {
      served += 1;
    });
    const headers = { "x-oxagen-client-ip": "198.51.100.40" };

    // Two requests spend the whole ceiling against a healthy store.
    await mw(fakeContext({ headers }), next);
    await mw(fakeContext({ headers }), next);
    expect(next).toHaveBeenCalledTimes(2);

    // The store drops. The ceiling is already spent, so the degraded path must
    // refuse rather than start a fresh count.
    storeUp = false;
    const third = (await mw(fakeContext({ headers }), next)) as
      | { body: unknown; status: number }
      | undefined;
    const fourth = (await mw(fakeContext({ headers }), next)) as
      | { status: number }
      | undefined;

    expect(third?.status).toBe(429);
    expect(third?.body).toMatchObject({ error: "rate_limited" });
    expect(fourth?.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(2);
  });

  // The inverse ordering of the case above, and the one recording-without-
  // enforcing left open: the degraded path serves `max`, then the store comes
  // back and its counter starts at 1, which would permit a second full `max`.
  it("does not hand a second full allowance out when the store recovers mid-window", async () => {
    let storeUp = false;
    let healthyCount = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        if (!storeUp) throw new Error("db unavailable");
        healthyCount += 1;
        return fn({
          execute: vi.fn().mockResolvedValue([{ count: healthyCount }]),
        });
      },
    );
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 2,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.44" };

    // The whole ceiling is spent against a store that is down.
    await mw(fakeContext({ headers }), next);
    await mw(fakeContext({ headers }), next);
    expect(next).toHaveBeenCalledTimes(2);

    // Postgres comes back and starts counting this window from 1. The shadow
    // count is what has to answer.
    storeUp = true;
    const third = (await mw(fakeContext({ headers }), next)) as
      | { body: unknown; status: number }
      | undefined;

    expect(third?.status).toBe(429);
    expect(third?.body).toMatchObject({ error: "rate_limited" });
    expect(next).toHaveBeenCalledTimes(2);
  });

  // The crossings, not the steady states. Healthy is covered, fully-degraded is
  // covered, and both of the two P2s below live at a boundary the earlier cases
  // step over: a window rolling mid-request, and the store coming back inside a
  // window the shadow already owns.

  // The Postgres `window_start` is derived from a timestamp captured BEFORE the
  // upsert is awaited. If the shadow counter reads the clock again afterwards,
  // a request whose await crossed a window boundary is recorded in Postgres
  // under one window and locally under the next — one request in two windows.
  //
  // A burst entirely inside one window passes against the unfixed code, because
  // the boundary IS the defect. What separates them is a burst that straddles
  // it, so the clock is frozen either side and each request's window is pinned.
  it("counts a boundary-crossing request in the window it started in", async () => {
    vi.useFakeTimers();
    try {
      // One millisecond before the minute rolls. The store call advances the
      // clock past it, which is what a slow upsert does.
      vi.setSystemTime(new Date("2026-09-17T12:00:59.999Z"));
      mocks.withSystemDb.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          vi.advanceTimersByTime(2);
          // Postgres counts each window from 1, so only the shadow can deny.
          return fn({ execute: vi.fn().mockResolvedValue([{ count: 1 }]) });
        },
      );
      const mw = distributedRateLimiter({
        keyPrefix: "preauth",
        max: 2,
        bucketKey: trustedClientIpBucketKey,
        storeErrorPolicy: "degrade-to-local",
      });
      const next = vi.fn().mockResolvedValue(undefined);
      const headers = { "x-oxagen-client-ip": "198.51.100.60" };

      // Starts at 12:00:59.999, finishes at 12:01:00.001. Its shadow hit
      // belongs to the window ending 12:01:00 — the one the response's
      // X-RateLimit-Reset names.
      const crossing = fakeContext({ headers });
      await mw(crossing, next);
      expect(responseHeadersOf(crossing)["X-RateLimit-Reset"]).toBe(
        String(new Date("2026-09-17T12:01:00.000Z").getTime() / 1000),
      );

      // Two more, now wholly inside the new window. With the shadow hit in the
      // right window these are its 1st and 2nd; with the boundary-crossing one
      // wrongly counted here they are its 2nd and 3rd, and the last is a 429.
      await mw(fakeContext({ headers }), next);
      const third = (await mw(fakeContext({ headers }), next)) as
        | { status: number }
        | undefined;

      expect(third).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // The headers a client paces against. When the store comes back inside a
  // window the shadow already owns, the shadow is the operative ceiling and the
  // Postgres count is the smaller, irrelevant one. Reporting the smaller number
  // tells the client it has room and then rejects its next request.
  //
  // Asserting only that the next request is rejected passes against the unfixed
  // code — the rejection was already right. What discriminates is asserting the
  // number the client would have paced against, and then that the next outcome
  // matches it.
  it("reports the stricter of the two counts once the store recovers", async () => {
    let storeUp = false;
    let healthyCount = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        if (!storeUp) throw new Error("db unavailable");
        healthyCount += 1;
        return fn({
          execute: vi.fn().mockResolvedValue([{ count: healthyCount }]),
        });
      },
    );
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 5,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.61" };

    // Four served by the degraded path: the shadow count for this window is 4.
    for (let i = 0; i < 4; i += 1) await mw(fakeContext({ headers }), next);
    expect(next).toHaveBeenCalledTimes(4);

    // The store comes back and reports 1 for this window. The shadow says 5.
    storeUp = true;
    const recovered = fakeContext({ headers });
    const allowed = (await mw(recovered, next)) as
      | { status: number }
      | undefined;

    expect(allowed).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(5);
    // Not "4" — that is `max - count` from the Postgres side, and it is a
    // promise the next line breaks.
    expect(responseHeadersOf(recovered)["X-RateLimit-Remaining"]).toBe("0");

    const rejected = (await mw(fakeContext({ headers }), next)) as
      | { status: number }
      | undefined;
    expect(rejected?.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(5);
  });

  it("leaves a healthy limiter's ceiling exactly where it was", async () => {
    // The shadow gate must be inert while the store is up: the Postgres count
    // is global and the shadow per-instance, so `count > max` always fires
    // first and this mount still allows exactly `max`.
    let served = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        served += 1;
        return fn({ execute: vi.fn().mockResolvedValue([{ count: served }]) });
      },
    );
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 3,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.45" };

    for (let i = 0; i < 3; i += 1) await mw(fakeContext({ headers }), next);
    const fourth = (await mw(fakeContext({ headers }), next)) as
      | { status: number }
      | undefined;

    expect(next).toHaveBeenCalledTimes(3);
    expect(fourth?.status).toBe(429);
  });

  // A test that only asserts the second 429 passes against the unfixed code.
  // The discriminating assertion is that the store was not consulted again:
  // `degrade-to-local` exists to take load off a struggling database, and a
  // denial path that re-enters `withSystemDb` per request puts it back on.
  it("stops calling the store once a degraded bucket is exhausted", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 1,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.50" };

    await mw(fakeContext({ headers }), next); // allowed, local count 1
    const denied = (await mw(fakeContext({ headers }), next)) as
      | { status: number }
      | undefined;
    expect(denied?.status).toBe(429);

    const callsAfterFirstDenial = mocks.withSystemDb.mock.calls.length;
    const repeat = (await mw(fakeContext({ headers }), next)) as
      | { status: number }
      | undefined;

    expect(repeat?.status).toBe(429);
    expect(mocks.withSystemDb.mock.calls.length).toBe(callsAfterFirstDenial);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps the flapping ceiling per bucket", async () => {
    let storeUp = true;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        if (!storeUp) throw new Error("db unavailable");
        return fn({ execute: vi.fn().mockResolvedValue([{ count: 1 }]) });
      },
    );
    const mw = distributedRateLimiter({
      keyPrefix: "preauth",
      max: 1,
      bucketKey: trustedClientIpBucketKey,
      storeErrorPolicy: "degrade-to-local",
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(
      fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.41" } }),
      next,
    );
    storeUp = false;
    const otherCaller = await mw(
      fakeContext({ headers: { "x-oxagen-client-ip": "198.51.100.42" } }),
      next,
    );

    expect(otherCaller).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("does not accrue a local count on a fail-open limiter", async () => {
    // Only degrade-to-local mounts pay the per-request map entry; a fail-open
    // limiter has no fallback to seed.
    let storeUp = true;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        if (!storeUp) throw new Error("db unavailable");
        return fn({ execute: vi.fn().mockResolvedValue([{ count: 1 }]) });
      },
    );
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 1 });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.43" };

    await mw(fakeContext({ headers }), next);
    storeUp = false;
    const afterOutage = await mw(fakeContext({ headers }), next);

    expect(afterOutage).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("passes the request through uncounted when the store fails under the default policy", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("db unavailable"));
    const mw = distributedRateLimiter({ keyPrefix: "chat", max: 1 });
    const next = vi.fn().mockResolvedValue(undefined);
    const headers = { "x-oxagen-client-ip": "198.51.100.34" };

    await mw(fakeContext({ headers }), next);
    const second = await mw(fakeContext({ headers }), next);

    expect(second).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
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

describe("unattributable bucket", () => {
  // A ceiling whose bucket cannot be attributed to one caller is not a ceiling.
  // On a pre-authentication mount it is strictly worse than nothing: one abuser
  // exhausts the shared counter and every other caller is denied before its
  // credential is ever checked. The limiter must pass the request through
  // instead — the per-credential ceiling beside it still applies.
  it("skips entirely when the resolver cannot name a bucket", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    scriptCount(1);

    const next = vi.fn();
    const c = fakeContext();
    const res = await distributedRateLimiter({
      keyPrefix: "preauth-ip",
      max: 1,
      bucketKey: () => null,
      methods: "all",
      // The strictest policy this limiter has under ADR-082. The skip must hold
      // under it, not only under fail-open.
      storeErrorPolicy: "degrade-to-local",
    })(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res).toBeUndefined();
    // Never counted: no store round-trip at all.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    // And never denied.
    expect(c.json).not.toHaveBeenCalled();
    // The operator can see the deployment is not enforcing it.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toContain("TRUSTED_PROXY_CIDRS");
  });

  // The other half of the same contract: a resolver that DOES name a caller
  // must still be counted. Without this, a skip bug that skipped everything
  // would pass the case above.
  it("still counts when the resolver names a bucket", async () => {
    scriptCount(1);

    const next = vi.fn();
    const c = fakeContext();
    await distributedRateLimiter({
      keyPrefix: "preauth-ip",
      max: 1,
      bucketKey: () => "ip:198.51.100.1",
      methods: "all",
      storeErrorPolicy: "degrade-to-local",
    })(c, next);

    expect(mocks.withSystemDb).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
