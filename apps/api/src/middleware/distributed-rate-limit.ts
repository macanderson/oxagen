import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withSystemDb } from "@oxagen/database";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import { rateLimiter } from "./rate-limit";
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
 *      with a limited POST are never throttled.
 *   2. Derive the bucket key: workspace > org > client IP, prefixed with the
 *      route group so surfaces never share a bucket.
 *   3. ONE atomic upsert: INSERT ... ON CONFLICT DO UPDATE count = count + 1
 *      RETURNING count. The natural (bucket_key, window_start) PK is the
 *      conflict target.
 *   4. Set X-RateLimit-Limit/Remaining/Reset on every counted response; on
 *      breach, 429 { error: "rate_limited" } + Retry-After.
 *
 * STORE FAILURE POLICY (ADR-079): fail-open remains the default because rate
 * limiting is secondary for authenticated product surfaces. Pre-authentication
 * security boundaries opt into `"degrade-to-local"`, which hands the request to
 * the per-process limiter in rate-limit.ts rather than denying it. Neither
 * policy denies traffic on a store error: a limiter that cannot reach its
 * counters is a limiter problem, and turning it into a total ingress outage
 * costs more than the ceiling it was protecting. A store error is warned at
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
   * What to do when the shared counter store is unavailable (ADR-079).
   *
   * - `"fail-open"` (default) — pass the request through uncounted. The
   *   historical policy for authenticated product surfaces, where the limit is
   *   a spend guard rather than a security boundary.
   * - `"degrade-to-local"` — hand the request to the per-process limiter in
   *   rate-limit.ts, configured with this limiter's window, ceiling and bucket
   *   key. The ceiling stops being global and becomes `max` per warm instance;
   *   that is a weaker bound than the Postgres counter, and a real one.
   *
   * Neither option denies. `"degrade-to-local"` replaced a fail-closed policy
   * that answered 503 to every caller for as long as the store was unreachable
   * — see ADR-079 for why the deny bought nothing that the shared Postgres
   * outage had not already bought.
   */
  storeErrorPolicy?: "fail-open" | "degrade-to-local";
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
 * One enrolled machine, one bucket.
 *
 * The post-auth ceilings on the Tacho and Stella machine routes are documented
 * and sized per host, but they were using the default `deriveBucketKey`, which
 * picks `workspaceId`. Every enrolled machine carries a distinct API key and
 * shares its workspace, so a handful of daemons would exhaust one counter
 * between them and all receive 429 — and the first minutes after this limiter
 * starts counting for the first time are exactly when every host drains its
 * backlog at once. Key on the enrolled credential instead.
 *
 * Falls back to the workspace when no API key is on the context, which on these
 * routers means something other than an enrolled machine reached them; that is
 * the behaviour these mounts had before, so the fallback is never worse.
 *
 * Exported for the same reason as `deriveBucketKey`: so the derivation can be
 * unit-tested without a live DB.
 */
export function enrolledMachineBucketKey(c: Context<AppEnv>): string {
  const apiKeyId = c.get("apiKeyId");
  if (apiKeyId) return `machine:${apiKeyId}`;
  const workspaceId = c.get("workspaceId");
  if (workspaceId) return `ws:${workspaceId}`;
  const orgId = c.get("orgId");
  return orgId ? `org:${orgId}` : `ip:${clientIp(c)}`;
}

/**
 * Header the AWS edge sets from its own view of the connection. Caddy writes it
 * with `header_up`, which SETS the field — any copy a caller sent is replaced
 * before the request reaches this process — and fills it from Caddy's
 * `{client_ip}`, resolved under `trusted_proxies static private_ranges` plus
 * `trusted_proxies_strict` so it walks X-Forwarded-For from the right and lands
 * on the address the ALB observed rather than on anything the caller wrote.
 * See `infra/tools/caddy/Caddyfile.alb`, and
 * `verifications/<session>/caddy-client-ip-header.txt` for that config answering
 * the four spoof shapes.
 */
const EDGE_CLIENT_IP_HEADER = "x-oxagen-client-ip";

/**
 * Longest address literal we accept. 45 characters is an IPv4-mapped IPv6
 * address (`0000:...:ffff:255.255.255.255`), the longest textual form there is.
 */
const MAX_CLIENT_IP_LENGTH = 45;

/** Characters that appear in an IPv4 or IPv6 literal, and nothing else. */
const IP_LITERAL_PATTERN = /^[0-9a-fA-F.:]+$/;

/**
 * Bound what a header can put into a bucket key. A trusted proxy should never
 * send anything but an address, so this is a guard against the proxy being
 * misconfigured rather than against the caller: an unbounded or structured
 * value would otherwise become an unbounded set of Postgres rows.
 */
function sanitizedIp(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_CLIENT_IP_LENGTH) return null;
  return IP_LITERAL_PATTERN.test(value) ? value : null;
}

/**
 * Per-client bucket for the pre-authentication ceilings, from whichever header
 * the deployment's own edge writes.
 *
 * Exactly one header is trusted per deployment shape, and in both cases the
 * edge SETS it rather than appending to it, so a caller-supplied copy cannot
 * survive: `x-vercel-forwarded-for` on Vercel, `x-oxagen-client-ip` from Caddy
 * on AWS. A value that is not an address literal, or that arrives on the wrong
 * deployment shape, falls back to the single `ip:unverified` bucket.
 *
 * Rejected, and why:
 *
 * - **`x-forwarded-for`, leftmost entry.** Caller-controlled. Neither the ALB
 *   nor Caddy strips an inbound copy — both append — so the leftmost entry is
 *   whatever the client wrote. A caller could rotate it to get a fresh bucket
 *   per request, or set a victim's address to spend someone else's ceiling.
 * - **`x-forwarded-for`, counted from the right.** Correct today: the ALB
 *   appends the address it saw (the client) and Caddy appends the address it
 *   saw (the ALB), so the client is second from the right. The hop count is the
 *   entire guarantee, though, and it is not visible from this file — add or
 *   remove a proxy and the chosen entry silently becomes attacker-controlled,
 *   with nothing here that could detect the change.
 * - **`x-real-ip`.** Neither the ALB nor Caddy sets it. Anything arriving under
 *   that name came from the caller.
 * - **Keeping the single `ip:unverified` bucket off Vercel.** What this
 *   replaces. It gave every caller on the internet one shared ceiling, made one
 *   Postgres row the write-contention point for the whole ingress, and — while
 *   these mounts were fail-closed — let that row's failure take Tacho and
 *   Stella intake offline (#3167).
 */
export function trustedClientIpBucketKey(c: Context<AppEnv>): string {
  if (process.env.VERCEL === "1") {
    const vercelClientIp = sanitizedIp(
      c.req.header("x-vercel-forwarded-for")?.split(",", 1)[0],
    );
    return `ip:${vercelClientIp ?? "unverified"}`;
  }
  const edgeClientIp = sanitizedIp(c.req.header(EDGE_CLIENT_IP_HEADER));
  return `ip:${edgeClientIp ?? "unverified"}`;
}

/** Domain separator — see authorizationFingerprintBucketKey. */
const CREDENTIAL_FINGERPRINT_DOMAIN = "oxagen:ratelimit:credential:v1\0";

/**
 * Stable pre-authentication credential bucket. Only a digest enters Postgres;
 * the Authorization header and raw bearer credential are never logged or stored
 * by the limiter.
 *
 * The digest is domain-separated. A bare `sha256(rawKey)` is byte-identical to
 * `auth.api_keys.key_hash` — the value `resolveApiKey` compares against to
 * authenticate — so writing it into `ratelimit.rate_limit_counters.bucket_key`
 * would put the auth verifier into a second table with a different access
 * surface and a different retention story. Prefixing a fixed domain string
 * makes the two digests unrelated while keeping this one stable per credential.
 */
export function authorizationFingerprintBucketKey(c: Context<AppEnv>): string {
  const authorization = c.req.header("authorization")?.trim() ?? "";
  const credential = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : authorization;
  const fingerprint = createHash("sha256")
    .update(CREDENTIAL_FINGERPRINT_DOMAIN)
    .update(credential)
    .digest("hex");
  return `credential:${fingerprint}`;
}

// Throttle store-error warnings to at most one per window per route group, so a
// store outage logs a signal without drowning the logs in one line per request.
const lastWarnAtByPrefix = new Map<string, number>();

/**
 * Flatten an error and its `cause` chain into one string.
 *
 * This used to log `err.message` alone. Drizzle wraps every failure in a
 * DrizzleQueryError whose message is only the SQL text and the bound params, so
 * the actual reason — a driver TypeError, a Postgres SQLSTATE, a dead socket —
 * lived in `cause` and never reached CloudWatch. Production spent that outage
 * showing a query that looked perfectly valid and no reason for it to fail.
 * Whatever breaks this store next, the log should name it.
 */
function describeError(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
}
function warnStoreError(
  keyPrefix: string,
  windowMs: number,
  err: unknown,
  storeErrorPolicy: "fail-open" | "degrade-to-local",
): void {
  const now = Date.now();
  if (now - (lastWarnAtByPrefix.get(keyPrefix) ?? 0) < windowMs) return;
  lastWarnAtByPrefix.set(keyPrefix, now);
  logger.warn(
    {
      keyPrefix,
      err: describeError(err),
      storeErrorPolicy,
    },
    storeErrorPolicy === "degrade-to-local"
      ? "distributed rate limiter store error — degrading to the per-instance limiter"
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
    // `.toISOString()` + an explicit cast, never the Date itself — see the
    // note on the increment upsert in `distributedRateLimiter` below. A raw
    // Date bound through `sql` throws in the driver before Postgres is even
    // reached, and this sweep swallows its errors, so the bug was silent here:
    // every sampled sweep since this limiter shipped has thrown and deleted
    // nothing.
    await tx.execute(sql`
      DELETE FROM ratelimit.rate_limit_counters
      WHERE window_start < ${olderThan.toISOString()}::timestamptz
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
  const storeErrorPolicy = opts.storeErrorPolicy ?? "fail-open";
  const localDenyUntilByKey = new Map<string, number>();

  const bucketKeyOf = (c: Context<AppEnv>): string =>
    opts.bucketKey
      ? `${opts.keyPrefix}:${opts.bucketKey(c)}`
      : deriveBucketKey(c, opts.keyPrefix);

  /**
   * The degraded ceiling, built on the first store failure and kept for the
   * life of this limiter so its buckets survive across failed requests. It
   * counts the same keys in the same window as the Postgres counter; only the
   * scope narrows, from global to this process.
   */
  let localFallback: MiddlewareHandler<AppEnv> | null = null;
  function localFallbackLimiter(max: number): MiddlewareHandler<AppEnv> {
    localFallback ??= rateLimiter({ windowMs, max, keyFn: bucketKeyOf });
    return localFallback;
  }

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

    const key = bucketKeyOf(c);
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
        // The window is bound as ISO-8601 text with an explicit ::timestamptz
        // cast, NOT as a Date. drizzle's `sql` template hands an interpolated
        // value straight to the driver as a bind parameter, and postgres.js
        // serializes parameters with `Buffer.byteLength(value)`, which throws
        //   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of
        //   type string or an instance of Buffer or ArrayBuffer. Received an
        //   instance of Date
        // for anything that is not already a string. (Drizzle converts Dates
        // for you when the statement is built from a typed table column; raw
        // `sql` has no column type to convert against, so it does not.)
        //
        // That threw on EVERY request, so this limiter had never once written
        // a counter: fail-open surfaces (chat, and the post-auth tacho/Stella
        // ceilings) silently stopped limiting, and the fail-closed pre-auth
        // ceilings on /v1/tacho/* and /v1/telemetry/stella/* answered 503
        // `rate_limit_unavailable` to every enrolled host. Keep the cast.
        const rows = (await tx.execute(sql`
          INSERT INTO ratelimit.rate_limit_counters AS c (bucket_key, window_start, count)
          VALUES (${key}, ${windowStart.toISOString()}::timestamptz, 1)
          ON CONFLICT (bucket_key, window_start)
          DO UPDATE SET count = c.count + 1
          RETURNING c.count
        `)) as unknown as { count: number }[];
        return rows[0]?.count ?? 0;
      });
    } catch (err) {
      warnStoreError(opts.keyPrefix, windowMs, err, storeErrorPolicy);
      if (storeErrorPolicy === "degrade-to-local") {
        return localFallbackLimiter(max)(c, next);
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
 * Per-minute budget for the chat surface, resolved from the validated env once
 * and memoized. Wrapped in a function (called at first request, not module
 * load) so importing the app never triggers env access — this mirrors
 * breaker-config.ts's `breakerEnvConfig()` and keeps route tests that mock
 * requireEnv from tripping over the limiter wiring.
 *
 * Chat is the only env-tunable budget left. ADR-043 excised the agent runtime,
 * and with it every surface that drew on RATE_LIMIT_AGENT_EXEC_PER_MIN (code
 * execution, compose, sandbox ops, background tasks, the A2A transport); that
 * env key is retired. The ceilings that remain on non-chat surfaces are
 * constants at their mount points, because they bound an ingress rather than a
 * per-deployment spend appetite.
 */
let cachedBudgets: { chat: number } | null = null;
export function rateLimitBudgets(): { chat: number } {
  if (cachedBudgets) return cachedBudgets;
  const env = requireEnv(["RATE_LIMIT_CHAT_PER_MIN"] as const);
  cachedBudgets = { chat: env.RATE_LIMIT_CHAT_PER_MIN };
  return cachedBudgets;
}
