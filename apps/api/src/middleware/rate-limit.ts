import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

export interface RateLimitOptions {
  /** Rolling window size, milliseconds. */
  windowMs: number;
  /** Max requests per key within one window. */
  max: number;
  /** Derives the bucket key from the request. Defaults to the client IP. */
  keyFn?: (c: Context<AppEnv>) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Hard ceiling on tracked keys per counter instance. Reaching it evicts rather
 * than merely sweeping — see `hit` for why that distinction is the whole point.
 */
const MAX_TRACKED_KEYS = 10_000;

/** One counted hit: the running count for the key and when its window resets. */
export interface FixedWindowHit {
  count: number;
  resetAt: number;
}

/** A bounded in-process fixed-window counter. */
export interface FixedWindowCounter {
  /**
   * Count one request against `key`.
   *
   * `now` is the caller's captured clock. It exists because
   * `distributedRateLimiter` derives its Postgres `window_start` from a
   * timestamp taken BEFORE awaiting the upsert, and if this counter read the
   * clock again afterwards a request whose await crossed a window boundary
   * would be recorded in Postgres under one window and here under the next.
   * One request in two windows is the same class of divergence as one
   * allowance spent twice, and the only way it cannot recur is for both
   * counters to derive their window from one captured value.
   */
  hit: (key: string, now?: number) => FixedWindowHit;
  /** Tracked keys. Exposed so the bound itself can be asserted in a test. */
  readonly size: number;
}

/**
 * An in-process fixed-window counter, shared by this file's middleware and by
 * `distributedRateLimiter`'s degraded path so both count the same key into the
 * same window.
 *
 * The window is anchored to the epoch (`floor(now / windowMs) * windowMs`),
 * NOT to the key's first hit. That matters because the degraded path has to
 * agree with the Postgres counter, which anchors its `window_start` the same
 * way: a window that started whenever this process first saw the key would let
 * a caller's local and distributed allowances straddle each other. It also
 * makes this file's doc comment true — it has said "fixed-window" since it was
 * written while the code rolled the window forward from each first hit.
 *
 * ## The map is bounded by eviction, not by expiry
 *
 * This counter is fed by pre-authentication limiters, so an unauthenticated
 * caller chooses its own keys: one per `Authorization` value on the credential
 * mounts. The bound therefore has to hold WITHIN a single window, against a
 * caller that is deliberately minting keys.
 *
 * The previous version swept entries whose window had expired, above a
 * threshold, on every hit. That bounds the map ACROSS windows and does nothing
 * within one: mid-window nothing is expired, so past the threshold the sweep
 * deleted nothing, scanned the whole map on every request — O(n) per request,
 * quadratic over a flood — and the map kept growing. Two source IPs could stay
 * under Tacho's 6,000-per-IP ceiling while creating more than 10,000 credential
 * buckets in a minute. A comment calling that a sweep read like a bound and was
 * not one.
 *
 * So: a hard `MAX_TRACKED_KEYS`, and at the cap the oldest entry is evicted.
 * That is the pattern `cacheLocalDeny` already uses in distributed-rate-limit.ts.
 * A key is re-inserted when its window rolls, so the map's iteration order is
 * "least recently started a window first" and eviction discards stale keys
 * before live ones. `Map.set` on an existing key keeps its original position,
 * which is why the roll path deletes before setting; without that a long-lived
 * legitimate key would sit at the front forever and be evicted first.
 *
 * What eviction costs, stated plainly: a caller flooding distinct keys can push
 * another caller's count out of the map and hand it a fresh allowance. That is
 * a weaker guarantee than an unbounded map would give and a much better one
 * than running out of memory. On the healthy path it is not the operative
 * ceiling at all — the Postgres counter is authoritative and global there, and
 * this counter is the shadow that catches a store that flaps. On the degraded
 * path it is the only ceiling, and a bounded, evictable ceiling is what that
 * path is for.
 */
export function createFixedWindowCounter(windowMs: number): FixedWindowCounter {
  const buckets = new Map<string, Bucket>();

  return {
    get size(): number {
      return buckets.size;
    },

    hit(key: string, at?: number): FixedWindowHit {
      const now = at ?? Date.now();
      const bucket = buckets.get(key);
      if (bucket && now < bucket.resetAt) {
        bucket.count += 1;
        return { count: bucket.count, resetAt: bucket.resetAt };
      }

      // New key, or this key's window has rolled. Delete before setting so the
      // entry moves to the back of the iteration order — see the note above.
      buckets.delete(key);
      while (buckets.size >= MAX_TRACKED_KEYS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }

      const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
      buckets.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    },
  };
}

/** Best-effort client IP: the standard proxy header chain, falling back to "unknown". */
function defaultKeyFn(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Minimal in-memory, fixed-window rate limiter for the public, unauthenticated
 * routes (`/v1/telemetry/usage`).
 *
 * Rate limiting here is a SECONDARY defense. The primary one is each route's
 * `.strict()` schema validation, which bounds the damage even if a caller
 * blows past the limit. Two limits of this limiter are real and deliberate:
 *
 *  - The bucket map is per-process, so on a multi-instance / serverless deploy
 *    the effective ceiling is `max` per warm instance, not globally. The
 *    authenticated expensive surfaces use `distributedRateLimiter`
 *    (distributed-rate-limit.ts) instead, whose counters live in Postgres and
 *    are therefore global.
 *  - `defaultKeyFn` reads `x-forwarded-for` / `x-real-ip`, which any client can
 *    set. A caller who varies that header per request gets a fresh bucket every
 *    time, and each distinct value costs a map entry. Pass an explicit `keyFn`
 *    (see `trustedClientIpBucketKey` in distributed-rate-limit.ts for the shape
 *    of a trustworthy one) on any route where that matters.
 */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const counter = createFixedWindowCounter(opts.windowMs);
  const keyFn = opts.keyFn ?? defaultKeyFn;

  return async (c, next) => {
    const { count, resetAt } = counter.hit(keyFn(c));

    if (count > opts.max) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((resetAt - Date.now()) / 1000),
      );
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        { error: "rate_limited", message: "Too many requests" },
        429,
      );
    }

    await next();
  };
}
