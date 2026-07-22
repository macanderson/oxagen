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
 * FAIL OPEN: any store error allows the request (rate limiting is a SECONDARY
 * defense — auth + strict schemas are primary). We never take chat/agents down
 * because the counter store hiccuped; a store error is warned at most once per
 * window so an outage cannot spam the logs.
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
   * HTTP methods that count against the limit; every other method passes
   * through unlimited. Defaults to POST — all the expensive chat/agent
   * operations are POST, and this lets a wildcard mount (e.g. /agent/sandbox/*)
   * cover the POST writes without throttling the co-located GET reads.
   */
  methods?: readonly string[];
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
function warnFailOpen(keyPrefix: string, windowMs: number, err: unknown): void {
  const now = Date.now();
  if (now - (lastWarnAtByPrefix.get(keyPrefix) ?? 0) < windowMs) return;
  lastWarnAtByPrefix.set(keyPrefix, now);
  logger.warn(
    {
      keyPrefix,
      err: err instanceof Error ? err.message : String(err),
    },
    "distributed rate limiter store error — failing open (allowing request)",
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

  return async (c, next) => {
    if (!methods.includes(c.req.method)) return next();

    const key = opts.bucketKey
      ? `${opts.keyPrefix}:${opts.bucketKey(c)}`
      : deriveBucketKey(c, opts.keyPrefix);
    const now = Date.now();
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs);
    const resetSeconds = Math.ceil((windowStartMs + windowMs) / 1000);

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
      warnFailOpen(opts.keyPrefix, windowMs, err);
      return next();
    }

    // Opportunistic, non-blocking cleanup on a small fraction of counted hits.
    if (Math.random() < CLEANUP_SAMPLE_RATE) {
      sweepStaleWindows(new Date(windowStartMs - windowMs * 2));
    }

    const max = typeof opts.max === "function" ? opts.max() : opts.max;
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count)));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (count > max) {
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
