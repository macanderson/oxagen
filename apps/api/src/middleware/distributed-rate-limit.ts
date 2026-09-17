import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withSystemDb } from "@oxagen/database";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import { extractTrustedClientIp } from "@oxagen/oxagen/client-ip";
import { createFixedWindowCounter } from "./rate-limit";
import {
  trustedProxyCidrs,
  __resetTrustedProxyHopsForTests,
} from "../lib/context";
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
 * STORE FAILURE POLICY (ADR-082): fail-open remains the default because rate
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
   * What to do when the shared counter store is unavailable (ADR-082).
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
   * — see ADR-082 for why the deny bought nothing that the shared Postgres
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
   * and the limiter SKIPS — it does not count, and it does not deny, whatever
   * the `storeErrorPolicy`. A resolver must never substitute a
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

/**
 * Whether the edge-written `x-oxagen-client-ip` header is believed, resolved
 * from the validated env once and memoized, and read lazily for the same reason
 * as `rateLimitBudgets()` below: importing the app must not trigger env access.
 *
 * Off by default. The header is trustworthy only because Caddy SETS it, and
 * that config ships through the infra pipeline while this code ships through
 * the application one. Until the flag is on the header is not read at all, so a
 * caller-supplied copy of it cannot mint a bucket of its own; attribution then
 * rests on TRUSTED_PROXY_CIDRS, and where that is unset the pre-authentication
 * ceilings skip. See packages/oxagen/src/client-ip.ts.
 */
let cachedTrustEdgeHeader: boolean | null = null;
function trustEdgeHeader(): boolean {
  if (cachedTrustEdgeHeader !== null) return cachedTrustEdgeHeader;
  cachedTrustEdgeHeader = requireEnv([
    "TRUST_EDGE_CLIENT_IP_HEADER",
  ] as const).TRUST_EDGE_CLIENT_IP_HEADER;
  return cachedTrustEdgeHeader;
}

/**
 * Client IP for the last-resort bucket, through the shared derivation so this
 * file has no second opinion about who a caller is. It read the leftmost
 * `x-forwarded-for` entry and then `x-real-ip`, both caller-written, which let
 * one client mint an unbounded number of buckets by varying a header.
 *
 * Only the edge header and the named-proxy walk can name a caller, the same two
 * as `trustedClientIpBucketKey` — there is no third, weaker reading left in the
 * derivation to fall back to.
 *
 * Unlike the pre-authentication ceilings, this one falls back to a shared
 * `ip:unknown` partition rather than skipping. That is safe only because
 * `deriveBucketKey` serves the fail-open, post-authentication surfaces, where
 * the request has already been attributed to a workspace or an org in all but
 * the residual case. A pre-authentication ceiling must never take this
 * fallback — see `trustedClientIpBucketKey`.
 */
function clientIp(c: Context<AppEnv>): string {
  return (
    extractTrustedClientIp((name) => c.req.header(name), {
      trustedProxyCidrs: trustedProxyCidrs(),
      trustEdgeHeader: trustEdgeHeader(),
      onVercel: process.env.VERCEL === "1",
    }) ?? "unknown"
  );
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
/**
 * Per-client bucket for the pre-authentication ceilings, or `null` when this
 * deployment cannot say who the caller is.
 *
 * The address itself comes from `extractTrustedClientIp`
 * (`@oxagen/oxagen/client-ip`), which is the one derivation every surface in
 * the repo reads a client address through, and which documents why each header
 * is or is not believed. A limiter bucket and an IAM `ip_ranges` decision want
 * the same answer to the same question, and the two diverging is how the
 * leftmost `x-forwarded-for` entry ended up deciding a mandate while this file
 * had already stopped trusting it.
 *
 * Two declarations can name a caller here, and NEITHER of them is a hop count —
 * that form is gone from the derivation entirely (#3205):
 *
 *  - the edge header `x-oxagen-client-ip`, once `TRUST_EDGE_CLIENT_IP_HEADER`
 *    says the Caddy config that SETS it is deployed (ADR-083);
 *  - `TRUSTED_PROXY_CIDRS`, which names the proxies so the chain walk stops on
 *    what an entry IS rather than on how many entries there are.
 *
 * A hop count cannot defend itself anywhere, which is why it no longer exists.
 * One that is too high lets a caller pad `x-forwarded-for` until the arithmetic
 * lands on a value the caller chose — here, a fresh bucket per request and no
 * ceiling at all; on the IAM path, an allowlist it should have failed. Nothing
 * readable from the request separates that from a correct deeper chain.
 *
 * Returning `null` is load-bearing. It means the request cannot be attributed,
 * and the limiter SKIPS — it does not count and it does not deny. The
 * alternative this replaced was a single shared `ip:unverified` bucket, which
 * on a mount that runs before any credential exists is not a ceiling but one
 * caller's power to deny the ingress to every other: send `max + 1` in a window
 * and every enrolled Tacho and Stella host is refused. It was also one Postgres
 * row as the write contention point for the whole ingress. The per-credential
 * ceiling mounted beside this one is unaffected either way, and a throttled
 * warn names the deployment fact so an operator sees it rather than inferring
 * it from a counter that never moves.
 */
export function trustedClientIpBucketKey(c: Context<AppEnv>): string | null {
  const ip = extractTrustedClientIp((name) => c.req.header(name), {
    trustedProxyCidrs: trustedProxyCidrs(),
    trustEdgeHeader: trustEdgeHeader(),
    onVercel: process.env.VERCEL === "1",
  });
  return ip ? `ip:${ip}` : null;
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

  // `bucketKey` may be async (main made it `string | Promise<string>`), so this
  // awaits it. Interpolating it directly would have rendered a pending promise
  // as the literal string "[object Promise]" — one bucket for every caller,
  // silently, which is the bug #3167 opened with.
  const bucketKeyOf = async (c: Context<AppEnv>): Promise<string | null> => {
    if (!opts.bucketKey) return deriveBucketKey(c, opts.keyPrefix);
    const suffix = await opts.bucketKey(c);
    // `null` means unattributable and propagates; it must never become the
    // string "null" in a bucket key, which would be a shared bucket by another
    // name.
    return suffix === null ? null : `${opts.keyPrefix}:${suffix}`;
  };

  /**
   * The degraded ceiling. It counts the same keys into the same epoch-anchored
   * window as the Postgres counter; only the scope narrows, from global to this
   * process.
   *
   * Every ALLOWED request is counted here, including the ones the Postgres
   * upsert handled. That looks redundant while the store is healthy and is the
   * whole point when it is not: a store that flaps sends some requests down the
   * success path and some down the failure path, and if only the failures were
   * counted locally a caller could spend `max` through Postgres and another
   * `max` through this counter inside one window — `2 × max` exactly when the
   * store is least reliable, which is not the bound ADR-082 states. Counting
   * both paths into one counter makes the degraded ceiling `max` in total,
   * however the window's requests happened to be split between them.
   *
   * The cost is one map entry per bucket key per window while the store is
   * healthy. On a pre-authentication mount the caller chooses its own keys, so
   * that cost is adversarial: `createFixedWindowCounter` bounds it with a hard
   * maximum and eviction rather than by sweeping expired entries, which bounds
   * nothing inside a single window. Only the `degrade-to-local` mounts pay it;
   * a fail-open limiter has no fallback to seed and never touches this.
   */
  const localCounter = createFixedWindowCounter(windowMs);

  function cacheLocalDeny(key: string, denyUntil: number, now: number): void {
    // A deny that has already expired is not a deny. The gate at the top of the
    // middleware would drop it on the very next request and go back to the
    // store — the round-trip this cache exists to avoid. Callers pass the reset
    // time of the window the request was counted in, derived from the same
    // captured clock, so this should not fire; it is a guard against those two
    // drifting apart again rather than a branch with a known caller.
    if (denyUntil <= now) return;
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

  /**
   * The crossings on this path, enumerated, because three separate findings on
   * this middleware were all about the state on the way to a state rather than
   * at it. Healthy and fully-degraded were each covered by a test; none of the
   * transitions were.
   *
   *  1. Store fails mid-request → the `catch` below, which counts against the
   *     captured `now` so the degraded hit lands in the window the rest of the
   *     request is about.
   *  2. Window rolls while the upsert is in flight → both counters derive their
   *     window from that same `now`. The counter takes it as an argument for
   *     exactly this reason; re-reading the clock put one request in two
   *     windows.
   *  3. Store recovers inside a window the shadow already owns → the headers
   *     and the decision both use the stricter of the two counts.
   *  4. A cached deny outliving its window → every `cacheLocalDeny` call passes
   *     the reset time of the window the request was counted in, and the
   *     function refuses a reset time that has already passed.
   *  5. Bucket key resolution awaits before `now` is captured, so the key and
   *     the window cannot disagree about which request this is.
   *
   * A fail-open mount reaches none of this: it has no fallback to seed and
   * never touches the local counter.
   */
  return async (c, next) => {
    if (methods !== "all" && !methods.includes(c.req.method)) return next();

    const key = await bucketKeyOf(c);
    if (key === null) {
      // The resolver could not name a caller. Skip rather than pool: an
      // unattributable ceiling converts one abuser into an outage for everyone
      // else, which on these pre-auth mounts is strictly worse than no ceiling.
      warnUnattributable(opts.keyPrefix, windowMs);
      return next();
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
      if (storeErrorPolicy !== "degrade-to-local") return next();

      // `now`, not the counter's own clock: the upsert that just failed may
      // have taken this request across a window boundary, and the degraded
      // count has to land in the window the rest of this request is about.
      const local = localCounter.hit(key, now);
      c.header("X-RateLimit-Limit", String(max));
      c.header("X-RateLimit-Remaining", String(Math.max(0, max - local.count)));
      c.header("X-RateLimit-Reset", String(Math.ceil(local.resetAt / 1000)));
      if (local.count > max) {
        // Cache the denial, exactly as the healthy path does. Without this,
        // every further request from an exhausted bucket re-enters the `try`
        // above, waits for `withSystemDb` to fail AGAIN, and only then rejects
        // — a failing database round-trip per request, under the flood this
        // limiter exists for, against a store that is already unwell.
        // `degrade-to-local` exists to take load OFF the store; a denial path
        // that puts it back on is the mode defeating its own purpose.
        cacheLocalDeny(key, local.resetAt, now);
        c.header(
          "Retry-After",
          String(Math.max(1, Math.ceil((local.resetAt - now) / 1000))),
        );
        return c.json({ error: "rate_limited" }, 429);
      }
      return next();
    }

    // Opportunistic, non-blocking cleanup on a small fraction of counted hits.
    if (Math.random() < CLEANUP_SAMPLE_RATE) {
      sweepStaleWindows(new Date(windowStartMs - windowMs * 2));
    }

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (count > max) {
      c.header("X-RateLimit-Remaining", "0");
      cacheLocalDeny(key, resetAtMs, now);
      const retryAfter = Math.max(1, resetSeconds - Math.ceil(now / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited" }, 429);
    }

    // Mirror the allowed request into the degraded counter, and ENFORCE the
    // shadow count as well as record it. Recording alone closes only one of the
    // two flapping orderings: healthy-then-failed, where the local counter
    // starts from the count Postgres already reached. Failed-then-healthy stays
    // open, because the recovered Postgres counter starts at 1 and would permit
    // a second full `max` on top of the one the degraded path already served.
    // The two ceilings bound the same window, so whichever of them is exhausted
    // is the one that answers.
    //
    // This changes nothing on a healthy mount. The Postgres count is global and
    // the shadow is per-instance, so the shadow can never exceed it while the
    // store is up and `count > max` always fires first.
    //
    // `now` is passed in for the same reason as on the catch path: the upsert
    // may have taken this request across a window boundary, and a shadow hit
    // that re-read the clock would land in the NEXT window — counting one
    // request twice and, worse, caching a denial against a reset time that had
    // already passed.
    //
    // `effectiveCount` is the stricter of the two, and it is what the headers
    // report. Reporting the Postgres count while the shadow is the operative
    // ceiling tells a client it has room and then rejects its next request; a
    // header a client paces against and cannot trust is worse than no header.
    let effectiveCount = count;
    if (storeErrorPolicy === "degrade-to-local") {
      const shadow = localCounter.hit(key, now);
      effectiveCount = Math.max(count, shadow.count);
    }

    c.header(
      "X-RateLimit-Remaining",
      String(Math.max(0, max - effectiveCount)),
    );

    if (effectiveCount > max) {
      cacheLocalDeny(key, resetAtMs, now);
      c.header(
        "Retry-After",
        String(Math.max(1, resetSeconds - Math.ceil(now / 1000))),
      );
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

/**
 * Test seam: drop the memoized env reads so a case can set a different value.
 * The edge-header flag is the one that matters here — a case asserting the
 * forged-header behaviour has to be able to turn it on and off.
 */
export function __resetRateLimitEnvForTests(): void {
  cachedBudgets = null;
  cachedTrustEdgeHeader = null;
  // `trustedProxyCidrs()` memoizes in lib/context.ts, and the memo outliving a
  // case is how a test that names proxies changes how a later one attributes an
  // address — a green run for the wrong reason.
  __resetTrustedProxyHopsForTests();
}
