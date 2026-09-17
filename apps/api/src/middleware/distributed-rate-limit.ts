import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withSystemDb } from "@oxagen/database";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import { rateLimiter } from "./rate-limit";
import { extractClientIp, trustedProxyCidrs } from "../lib/context";
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
   * collisions. Resolvers must return non-secret, bounded values. A resolver
   * that reads the request body returns a promise.
   *
   * Returning `null` means "this request cannot be attributed to a bucket",
   * and the limiter SKIPS — it does not count, and it does not deny, not even
   * when `storeErrorPolicy` is `"degrade-to-local"`. A resolver must never substitute a
   * shared constant for an identity it cannot establish: every caller in one
   * bucket is not a ceiling, it is one abuser's power to lock everyone else
   * out. See `trustedClientIpBucketKey`.
   */
  bucketKey?: (c: Context<AppEnv>) => string | null | Promise<string | null>;
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
 * The client address, as far as this deployment can actually vouch for it, or
 * `null` when it cannot vouch for one at all.
 *
 * This used to return the constant `ip:unverified` for every caller whenever
 * `VERCEL !== "1"` — which is always, since production runs on AWS behind an
 * ALB and Caddy. A single bucket shared by every caller on the internet is not
 * a rate limit; it is shared fate. It was harmless only because the counter
 * store threw on every request, and this PR fixes that: on these fail-closed
 * pre-auth mounts, one client sending `max + 1` requests in a window would take
 * the entire Tacho and Stella ingress offline for everyone, before any
 * credential was checked. That is a denial of service handed to anyone who can
 * reach the host.
 *
 * So: derive a real client address. `extractClientIp` (lib/context.ts) already
 * does the hardened version of this — it walks the forwarded-for chain from the
 * RIGHT through the proxies named in TRUSTED_PROXY_CIDRS, so entries a caller
 * prepends itself can never move the entry it picks, and it is the same
 * derivation the IAM `ip_ranges` / `ip_allow` conditions are judged on.
 *
 * Returning `null` is deliberate and load-bearing: it means this deployment has
 * no trusted proxy chain to read, so there is no per-client bucket to enforce,
 * and the limiter SKIPS rather than lumping everyone together (see the
 * `bucketKey` contract). An unattributable ceiling is worse than no ceiling,
 * because it converts one abuser into an outage for every other caller. The
 * per-credential ceiling mounted beside this one is unaffected either way.
 *
 * The ceiling is therefore enforced ONLY where the deployment has named its
 * proxies, by setting TRUSTED_PROXY_CIDRS. A hop count is not enough here: it
 * trusts the COUNT to be right, and a count that is too high lets a caller pad
 * x-forwarded-for until the arithmetic lands on a value the caller chose, which
 * on this ceiling means a fresh bucket per request and no ceiling at all.
 * Nothing in the request separates that from a correct deeper chain. Naming the
 * proxies does separate it: the walk stops on what an entry IS, so padding only
 * lengthens a prefix it never reaches. Undeclared proxies are an
 * unattributable request, so it skips.
 *
 * Production needs a change OUTSIDE this file before any depth is correct.
 * Caddy's `reverse_proxy` does not append to an inbound X-Forwarded-For unless
 * the peer is a trusted proxy — it REPLACES it. Measured against `caddy:2`:
 * a request arriving as `X-Forwarded-For: 203.0.113.99` reached the upstream as
 * `172.17.0.1` with a plain `reverse_proxy`, and as `203.0.113.99, 172.17.0.1`
 * once `trusted_proxies` was set. So until the Caddyfile change ships, the API
 * sees only the load balancer and NO hop count recovers a client. The
 * `trusted_proxies` block is in infra/tools/caddy/Caddyfile.alb; after it
 * deploys the chain is two deep and the depth to declare is 2.
 *
 * That leaves an unconfigured deployment exactly where it is today — this
 * counter has never once incremented — rather than switching on a ceiling
 * nobody has told us how to attribute. Naming the proxies turns it on.
 * Sequencing the Caddy deploy and that value is tracked on #3167; nothing here
 * enforces until both are done.
 */
export function trustedClientIpBucketKey(c: Context<AppEnv>): string | null {
  // Vercel replaces `x-vercel-forwarded-for` at its own trusted network
  // boundary, so it needs no hop arithmetic. Kept for preview deployments.
  if (process.env.VERCEL === "1") {
    const trustedForwardedFor = c.req
      .header("x-vercel-forwarded-for")
      ?.split(",", 1)[0]
      ?.trim();
    return trustedForwardedFor ? `ip:${trustedForwardedFor}` : null;
  }
  // These mounts require the SAFE form of the declaration: the proxies named by
  // identity, not counted. A hop count trusts itself to be right, and one that
  // is too high lets a caller pad x-forwarded-for until the arithmetic lands on
  // a value the caller chose — which on this ceiling means minting a fresh
  // bucket per request and evading it entirely. Nothing in the request
  // distinguishes an over-declared count from a correct deeper chain, so a
  // count cannot defend itself here. Undeclared proxies are an unattributable
  // request, and unattributable skips.
  if (trustedProxyCidrs().length === 0) return null;
  const clientAddress = extractClientIp(c);
  return clientAddress ? `ip:${clientAddress}` : null;
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

/**
 * A ceiling that cannot name who it is limiting is not being enforced, and that
 * is a deployment fact an operator should be able to see rather than infer from
 * a counter that never moves. Throttled per prefix like the store-error warn.
 */
const lastUnattributableWarnAtByPrefix = new Map<string, number>();
function warnUnattributable(keyPrefix: string, windowMs: number): void {
  const now = Date.now();
  if (now - (lastUnattributableWarnAtByPrefix.get(keyPrefix) ?? 0) < windowMs)
    return;
  lastUnattributableWarnAtByPrefix.set(keyPrefix, now);
  logger.warn(
    { keyPrefix },
    "distributed rate limiter has no attributable bucket for this request — " +
      "skipping (set TRUSTED_PROXY_CIDRS to the proxies in front of this " +
      "deployment)",
  );
}

export function distributedRateLimiter(
  opts: DistributedRateLimitOptions,
): MiddlewareHandler<AppEnv> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const methods = opts.methods ?? DEFAULT_METHODS;
  const storeErrorPolicy = opts.storeErrorPolicy ?? "fail-open";
  const localDenyUntilByKey = new Map<string, number>();

  /**
   * The bucket key this limiter already resolved for the in-flight request.
   *
   * The degraded ceiling has to count the SAME buckets the Postgres counter
   * would have, but `rateLimiter`'s `keyFn` is synchronous while `opts.bucketKey`
   * may be async and may return `null`. Re-deriving inside `keyFn` would
   * therefore stringify a pending promise — every caller would land in one
   * `"[object Promise]"` bucket, which is the shared-fate failure a per-client
   * bucket exists to prevent. So hand the resolved key across instead. Keyed on
   * the request context and weakly held, so nothing is retained past the
   * response.
   */
  const resolvedKeyByContext = new WeakMap<Context<AppEnv>, string>();

  /**
   * The degraded ceiling, built on the first store failure and kept for the
   * life of this limiter so its buckets survive across failed requests. It
   * counts the same keys in the same window as the Postgres counter; only the
   * scope narrows, from global to this process.
   */
  let localFallback: MiddlewareHandler<AppEnv> | null = null;
  function localFallbackLimiter(max: number): MiddlewareHandler<AppEnv> {
    localFallback ??= rateLimiter({
      windowMs,
      max,
      keyFn: (c) =>
        resolvedKeyByContext.get(c) ?? deriveBucketKey(c, opts.keyPrefix),
    });
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

    let key: string;
    if (opts.bucketKey) {
      const suffix = await opts.bucketKey(c);
      if (suffix === null) {
        warnUnattributable(opts.keyPrefix, windowMs);
        return next();
      }
      key = `${opts.keyPrefix}:${suffix}`;
    } else {
      key = deriveBucketKey(c, opts.keyPrefix);
    }
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
        resolvedKeyByContext.set(c, key);
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
