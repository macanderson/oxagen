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

/** Above this many tracked keys, opportunistically sweep expired buckets on the next request. */
const SWEEP_THRESHOLD = 10_000;

/** Best-effort client IP: the standard proxy header chain, falling back to "unknown". */
function defaultKeyFn(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Minimal in-memory, fixed-window rate limiter.
 *
 * This codebase has no shared rate-limit infrastructure yet (Better Auth's own
 * `rateLimits` table only guards its own auth routes), and a public,
 * unauthenticated route needs SOME abuse guard now rather than waiting on a
 * distributed limiter. Caveat, documented rather than hidden: the bucket map
 * is per-process, so on a multi-instance/serverless deploy the effective
 * limit is `max` per warm instance, not globally. Rate limiting here is a
 * SECONDARY defense — the primary one is the route's strict `.strict()`
 * schema validation, which bounds the damage even if a caller blows past the
 * limit. Swap the store for Redis/Upstash later without changing any call
 * site — `RateLimitOptions` and the returned middleware shape stay the same.
 */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? defaultKeyFn;

  function sweepExpired(now: number): void {
    for (const [k, b] of buckets) {
      if (now >= b.resetAt) buckets.delete(k);
    }
  }

  return async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();

    if (buckets.size > SWEEP_THRESHOLD) sweepExpired(now);

    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      await next();
      return;
    }

    if (bucket.count >= opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "rate_limited", message: "Too many requests" }, 429);
    }

    bucket.count += 1;
    await next();
  };
}
