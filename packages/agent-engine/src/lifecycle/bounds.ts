/**
 * Lifecycle bounds — the small, dependency-free guards every long-lived or
 * dispatched agent process must carry so nothing runs forever or grows memory
 * without limit (fleet workers, detached session runners, the context daemon,
 * per-task fleet agents).
 *
 * Three primitives, one shape:
 *
 *   - {@link startMaxLifetime} — a hard wall-clock ceiling. Fires `onExpire`
 *     exactly once; the owner decides how to abort gracefully (flush logs,
 *     emit a terminal event, exit non-zero) — this module never calls
 *     `process.exit`.
 *   - {@link startRssWatchdog} — periodic `process.memoryUsage().rss` check
 *     against a byte ceiling: `onWarn` once at `warnRatio`, `onLimit` once at
 *     the ceiling (then the watchdog stops itself).
 *   - {@link resolveBoundMs} / {@link resolveBoundBytes} — env-override
 *     resolution so every ceiling is configurable and can be disabled
 *     (`0`/`off`) without a code change.
 *
 * Every timer is `unref`'d: a bound must never be the thing keeping an
 * otherwise-finished process alive.
 */

export interface BoundHandle {
  /** Cancel the bound. Idempotent; safe to call after it has fired. */
  stop(): void;
}

export interface MaxLifetimeOptions {
  /** Ceiling in ms. `<= 0` or non-finite disables the bound entirely. */
  ms: number;
  /** Invoked exactly once when the ceiling elapses. */
  onExpire: () => void;
}

/** A no-op handle for disabled bounds — callers never need a null check. */
const NOOP_HANDLE: BoundHandle = { stop: () => {} };

/**
 * Start a hard wall-clock ceiling. The caller's `onExpire` should abort the
 * work gracefully (abort a controller, emit a terminal event) rather than
 * exiting mid-write.
 */
export function startMaxLifetime(opts: MaxLifetimeOptions): BoundHandle {
  if (!Number.isFinite(opts.ms) || opts.ms <= 0) return NOOP_HANDLE;
  let fired = false;
  const timer = setTimeout(() => {
    if (fired) return;
    fired = true;
    opts.onExpire();
  }, opts.ms);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      fired = true;
      clearTimeout(timer);
    },
  };
}

export interface RssWatchdogOptions {
  /** RSS ceiling in bytes. `<= 0` or non-finite disables the watchdog. */
  maxRssBytes: number;
  /** Poll cadence (default 30 s). */
  intervalMs?: number;
  /** Fraction of the ceiling at which `onWarn` fires once (default 0.8). */
  warnRatio?: number;
  /** Fired ONCE when rss crosses `warnRatio * maxRssBytes`. */
  onWarn?: (rssBytes: number, maxRssBytes: number) => void;
  /**
   * Fired ONCE when rss reaches the ceiling; the watchdog stops itself first
   * so a slow graceful shutdown can't re-trigger it.
   */
  onLimit: (rssBytes: number, maxRssBytes: number) => void;
  /** Injectable rss reader for tests. Defaults to `process.memoryUsage().rss`. */
  readRss?: () => number;
}

/**
 * Watch this process's resident set size against a ceiling. Warn at
 * `warnRatio`, abort (via `onLimit`) at the ceiling — the caller owns the
 * graceful teardown.
 */
export function startRssWatchdog(opts: RssWatchdogOptions): BoundHandle {
  if (!Number.isFinite(opts.maxRssBytes) || opts.maxRssBytes <= 0)
    return NOOP_HANDLE;
  const intervalMs = opts.intervalMs ?? 30_000;
  const warnRatio = opts.warnRatio ?? 0.8;
  const readRss = opts.readRss ?? ((): number => process.memoryUsage().rss);
  let warned = false;
  let stopped = false;

  const check = (): void => {
    if (stopped) return;
    let rss: number;
    try {
      rss = readRss();
    } catch {
      return; // A failed sample must never take the process down.
    }
    if (rss >= opts.maxRssBytes) {
      stop();
      opts.onLimit(rss, opts.maxRssBytes);
      return;
    }
    if (!warned && rss >= opts.maxRssBytes * warnRatio) {
      warned = true;
      opts.onWarn?.(rss, opts.maxRssBytes);
    }
  };

  const timer = setInterval(check, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
}

/**
 * Resolve a millisecond bound from an env var with a default. Accepts a plain
 * integer; `0`, a negative value, or `"off"` disables the bound (returns 0);
 * absent/unparsable falls back to `defaultMs`.
 */
export function resolveBoundMs(
  envVar: string,
  defaultMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveBound(env[envVar], defaultMs);
}

/**
 * Resolve a byte bound expressed in MEGABYTES in the env var (ceilings are
 * human-set; nobody wants to count bytes) with a default in bytes. Same
 * disable semantics as {@link resolveBoundMs}.
 */
export function resolveBoundBytes(
  envVar: string,
  defaultBytes: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[envVar];
  if (raw === undefined) return defaultBytes;
  if (raw.trim().toLowerCase() === "off") return 0;
  const mb = Number.parseInt(raw, 10);
  if (Number.isNaN(mb)) return defaultBytes;
  return mb <= 0 ? 0 : mb * 1024 * 1024;
}

function resolveBound(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (raw.trim().toLowerCase() === "off") return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return n <= 0 ? 0 : n;
}
