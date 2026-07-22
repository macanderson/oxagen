import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withSystemDb } from "@oxagen/database";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import type { AppEnv } from "../app";

/**
 * Distributed, org/workspace-keyed fixed-window rate limiter.
 *
 * The in-memory `rateLimiter` (rate-limit.ts) is per-process, so on a multi-
 * instance / serverless deploy its effective limit is `max` per warm instance —
 * fine for the low-value public routes it guards, useless for the expensive
 * chat + agent-execution surfaces where a single abusive workspace can fan a
 * request across every instance. This limiter instead keeps its counters in
 * Postgres (the only shared, transactional store in the stack) so the limit is
 * GLOBAL across instances. Postgres — not Redis/Upstash — because vendor-
 * neutrality is a core moat and Better Auth already keeps its own rate-limit
 * counters in Postgres; adding a cache vendor for this would earn its keep only
 * at a scale we are not at.
 *
 * Semantics, per request:
 *   1. Skip (pass through, no counting) unless the method is one we limit —
 *      default POST only, so cheap GET reads that share a mounted path prefix
 *      (e.g. /agent/sandbox/list under an /agent/sandbox/* mount) are never
 *      throttled.
 *   2. Derive the bucket key: workspace > org > client IP, prefixed with the
 *      route group so surfaces never share a bucket.
 *   3. ONE atomic upsert: INSERT ... ON CONFLICT DO UPDATE count = count + 1
 *      RETURNING count. The natural (bucket_key, window_start) PK is the
 *      conflict target.
 *   4. Set X-RateLimit-Limit/Remaining/Reset on every counted response; on
 *      breach, 429 { error: "rate_limited" } + Retry-After.
 *
 * STORE FAILURE POLICY: fail-open remains the default because rate limiting is
 * secondary for authenticated product surfaces. Pre-authentication security
 * boundaries may opt into fail-closed behavior. A store error is warned at
 * most once per window so an outage cannot spam the logs.
 *
 * Once the shared store reports an exhausted bucket, this warm instance caches
 * the denial until the fixed window resets. Repeated abusive requests then
 * receive 429 without continuing to write to Postgres.
 */
export interface DistributedRateLimitOptions {
  /** Route-group prefix so different surfaces don't share buckets, e.g. "chat". */
  keyPrefix: string;
  /**
   * Max counted requests per key within one window. May be a lazy resolver so
   * the env budget is read on first request, not at module load — importing the
   * app (e.g. in a route test that mocks requireEnv) must never trip env access.
   */
  max: number | (() => number);
  /** Fixed window size, milliseconds. Defaults to 60_000 (one minute). */
  windowMs?: number;
  /**
   * HTTP methods that count against the limit, or `"all"` to count every
   * method. Every other method passes through unlimited. Defaults to POST — all
   * the expensive chat/agent operations are POST, and this lets a wildcard
   * mount cover writes without throttling co-located GET reads.
   */
  methods?: readonly string[] | "all";
  /**
   * Deny when the shared counter store is unavailable. Defaults to false so
   * authenticated product surfaces preserve their historical fail-open policy.
   * Pre-authentication security boundaries should enable this explicitly.
   */
  failClosedOnStoreError?: boolean;
  /**
   * Optional unprefixed bucket suffix for pre-authentication or other custom
   * scopes. The limiter always prepends `keyPrefix`, preventing cross-surface
   * collisions. Resolvers must return non-secret, bounded values.
   */
  bucketKey?: (c: Context<AppEnv>) => string;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_METHODS = ["POST"] as const;
/** Fraction of counted requests that trigger an opportunistic stale-window sweep. */
const CLEANUP_SAMPLE_RATE = 0.01;
/** Bound exhausted-bucket memory per limiter instance. */
const LOCAL_DENY_CACHE_MAX = 10_000;

/** Best-effort client IP — the same proxy header chain as the in-memory limiter. */
function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Bucket scope, most-specific first: workspace > org > IP. Prefixed with the
 * route group so chat and agent surfaces never collide. Exported so the
 * ws→org→ip precedence can be unit-tested directly without a live DB.
 */
export function deriveBucketKey(c: Context<AppEnv>, keyPrefix: string): string {
  const workspaceId = c.get("workspaceId");
  if (workspaceId) return `${keyPrefix}:ws:${workspaceId}`;
  const orgId = c.get("orgId");
  if (orgId) return `${keyPrefix}:org:${orgId}`;
  return `${keyPrefix}:ip:${clientIp(c)}`;
}

/**
 * Vercel replaces `x-vercel-forwarded-for` from its trusted network boundary,
 * unlike caller-controlled `x-forwarded-for`. Outside Vercel, collapse all
 * traffic into one conservative bucket rather than trusting a spoofable IP.
 */
export function trustedVercelIpBucketKey(c: Context<AppEnv>): string {
  if (process.env.VERCEL !== "1") return "ip:unverified";
  const trustedForwardedFor = c.req
    .header("x-vercel-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  return `ip:${trustedForwardedFor || "unverified"}`;
}

/**
 * Stable pre-authentication credential bucket. Only a SHA-256 digest enters
 * Postgres; the Authorization header and raw bearer credential are never
 * logged or stored by the limiter.
 */
export function authorizationFingerprintBucketKey(c: Context<AppEnv>): string {
  const authorization = c.req.header("authorization")?.trim() ?? "";
  const credential = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : authorization;
  const fingerprint = createHash("sha256").update(credential).digest("hex");
  return `credential:${fingerprint}`;
}

// Throttle fail-open warnings to at most one per window per route group, so a
// store outage logs a signal without drowning the logs in one line per request.
const lastWarnAtByPrefix = new Map<string, number>();
function warnStoreError(
  keyPrefix: string,
  windowMs: number,
  err: unknown,
  failClosed: boolean,
): void {
  const now = Date.now();
  if (now - (lastWarnAtByPrefix.get(keyPrefix) ?? 0) < windowMs) return;
  lastWarnAtByPrefix.set(keyPrefix, now);
  logger.warn(
    {
      keyPrefix,
      err: err instanceof Error ? err.message : String(err),
      failClosed,
    },
    failClosed
      ? "distributed rate limiter store error — failing closed"
      : "distributed rate limiter store error — failing open (allowing request)",
  );
}

/**
 * Fire-and-forget GC of windows older than two full windows. Runs in its own
 * transaction (NOT the increment's — a sweep failure must never roll back or
 * block a request) and swallows every error: a missed sweep is harmless because
 * the next sampled request retries, and stale rows are never read.
 */
function sweepStaleWindows(olderThan: Date): void {
  void withSystemDb(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ratelimit.rate_limit_counters WHERE window_start < ${olderThan}
    `);
  }).catch(() => {
    /* best-effort — see doc comment */
  });
}

export function distributedRateLimiter(
  opts: DistributedRateLimitOptions,
): MiddlewareHandler<AppEnv> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const methods = opts.methods ?? DEFAULT_METHODS;
  const localDenyUntilByKey = new Map<string, number>();

  function cacheLocalDeny(key: string, denyUntil: number, now: number): void {
    if (localDenyUntilByKey.size >= LOCAL_DENY_CACHE_MAX) {
      for (const [cachedKey, cachedUntil] of localDenyUntilByKey) {
        if (cachedUntil <= now) localDenyUntilByKey.delete(cachedKey);
      }
      if (localDenyUntilByKey.size >= LOCAL_DENY_CACHE_MAX) {
        const oldestKey = localDenyUntilByKey.keys().next().value;
        if (oldestKey) localDenyUntilByKey.delete(oldestKey);
      }
    }
    localDenyUntilByKey.set(key, denyUntil);
  }

  return async (c, next) => {
    if (methods !== "all" && !methods.includes(c.req.method)) return next();

    const key = opts.bucketKey
      ? `${opts.keyPrefix}:${opts.bucketKey(c)}`
      : deriveBucketKey(c, opts.keyPrefix);
    const now = Date.now();
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const resetAtMs = windowStartMs + windowMs;
    const windowStart = new Date(windowStartMs);
    const resetSeconds = Math.ceil(resetAtMs / 1000);
    const max = typeof opts.max === "function" ? opts.max() : opts.max;

    const locallyDeniedUntil = localDenyUntilByKey.get(key);
    if (locallyDeniedUntil && locallyDeniedUntil > now) {
      c.header("X-RateLimit-Limit", String(max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(resetSeconds));
      c.header(
        "Retry-After",
        String(Math.max(1, Math.ceil((locallyDeniedUntil - now) / 1000))),
      );
      return c.json({ error: "rate_limited" }, 429);
    }
    if (locallyDeniedUntil) localDenyUntilByKey.delete(key);

    let count: number;
    try {
      count = await withSystemDb(async (tx) => {
        const rows = (await tx.execute(sql`
          INSERT INTO ratelimit.rate_limit_counters AS c (bucket_key, window_start, count)
          VALUES (${key}, ${windowStart}, 1)
          ON CONFLICT (bucket_key, window_start)
          DO UPDATE SET count = c.count + 1
          RETURNING c.count
        `)) as unknown as { count: number }[];
        return rows[0]?.count ?? 0;
      });
    } catch (err) {
      const failClosed = opts.failClosedOnStoreError === true;
      warnStoreError(opts.keyPrefix, windowMs, err, failClosed);
      if (failClosed) {
        c.header("Retry-After", "1");
        return c.json({ error: "rate_limit_unavailable" }, 503);
      }
      return next();
    }

    // Opportunistic, non-blocking cleanup on a small fraction of counted hits.
    if (Math.random() < CLEANUP_SAMPLE_RATE) {
      sweepStaleWindows(new Date(windowStartMs - windowMs * 2));
    }

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count)));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (count > max) {
      cacheLocalDeny(key, resetAtMs, now);
      const retryAfter = Math.max(1, resetSeconds - Math.ceil(now / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited" }, 429);
    }

    return next();
  };
}

/**
 * Per-minute budgets for the two limited surface groups, resolved from the
 * validated env once and memoized. Wrapped in a function (called at first
 * request, not module load) so importing the app never triggers env access —
 * this mirrors breaker-config.ts's `breakerEnvConfig()` and keeps route tests
 * that mock requireEnv from tripping over the limiter wiring.
 */
let cachedBudgets: { chat: number; agentExec: number } | null = null;
export function rateLimitBudgets(): { chat: number; agentExec: number } {
  if (cachedBudgets) return cachedBudgets;
  const env = requireEnv([
    "RATE_LIMIT_CHAT_PER_MIN",
    "RATE_LIMIT_AGENT_EXEC_PER_MIN",
  ] as const);
  cachedBudgets = {
    chat: env.RATE_LIMIT_CHAT_PER_MIN,
    agentExec: env.RATE_LIMIT_AGENT_EXEC_PER_MIN,
  };
  return cachedBudgets;
}
