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
 *
 * ## The accepted grammar
 *
 * An env-var ceiling is **a whole decimal integer, or the word `off`** — after
 * trimming, and nothing else. `120000` and `off` and `0` are the whole
 * vocabulary; `30d`, `2gb`, `1e9`, `1_000_000` and `0.5` are all rejected, fall
 * back to the default, and say so on stderr once.
 *
 * The strictness is the point. These resolvers used to run `Number.parseInt`,
 * which stops at the first character it cannot use and returns what it read so
 * far, reporting no error at all. `30d` became a 30-millisecond ceiling and
 * `2gb` became a 2-megabyte one — bounds orders of magnitude tighter than the
 * operator wrote, firing `onExpire` at once, and `onExpire` is wired to
 * graceful abort paths that emit a terminal event, so the run read as "hit its
 * ceiling" rather than as "misconfigured". Worse, `0.5` parsed to `0`, and `0`
 * is this module's own disable sentinel: a value written to *tighten* a
 * ceiling removed it. `Number.isNaN` was the only validity test and it cannot
 * see any of those (#1409).
 *
 * Unit suffixes are a deliberate non-feature. Accepting them is a larger
 * decision about a shared duration grammar; what could not stand is a suffix
 * silently parsing as its leading digits.
 *
 * ## Ceilings longer than 24 days
 *
 * {@link startMaxLifetime} honours any finite ceiling by chaining timers.
 * Node's `setTimeout` delay is a 32-bit signed integer, and a delay above
 * `TIMEOUT_MAX` (2 147 483 647 ms) does not clamp — Node sets the duration to
 * `1` and prints a `TimeoutOverflowWarning` to stderr, where a detached
 * runner's output is a log file nobody reads. The bound was therefore
 * inverted: the longer the ceiling asked for, the sooner the process died
 * (#1408). Chaining rather than clamping, because clamping to 24.8 days would
 * trade one wrong answer for another and say nothing.
 */

export interface BoundHandle {
  /** Cancel the bound. Idempotent; safe to call after it has fired. */
  stop(): void;
}

/**
 * The longest delay Node's `setTimeout` accepts: a 32-bit signed integer of
 * milliseconds, about 24 days 20 hours. A larger delay is not clamped — the
 * duration is set to `1` — so any ceiling past this has to be chained.
 */
export const TIMEOUT_MAX = 2_147_483_647;

/** The subset of `setTimeout`/`clearTimeout` this module needs. */
export type TimerHandle = unknown;

export interface MaxLifetimeOptions {
  /** Ceiling in ms. `<= 0` or non-finite disables the bound entirely. */
  ms: number;
  /** Invoked exactly once when the ceiling elapses. */
  onExpire: () => void;
  /**
   * Injectable scheduler for tests, mirroring {@link RssWatchdogOptions.readRss}.
   * Defaults to the global timers. A ceiling past {@link TIMEOUT_MAX} is
   * chained, so a test can assert the requested delays without waiting weeks.
   */
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  /** Companion to {@link MaxLifetimeOptions.setTimeoutFn}. */
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/** A no-op handle for disabled bounds — callers never need a null check. */
const NOOP_HANDLE: BoundHandle = { stop: () => {} };

/**
 * Start a hard wall-clock ceiling. The caller's `onExpire` should abort the
 * work gracefully (abort a controller, emit a terminal event) rather than
 * exiting mid-write.
 *
 * A ceiling longer than {@link TIMEOUT_MAX} is honoured by re-arming across
 * however many timers it takes, so the process is bounded at the time asked
 * for. `Infinity` and any non-finite value still disable the bound rather than
 * chaining forever, and every timer is still `unref`'d.
 */
export function startMaxLifetime(opts: MaxLifetimeOptions): BoundHandle {
  if (!Number.isFinite(opts.ms) || opts.ms <= 0) return NOOP_HANDLE;
  const schedule =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms));
  const cancel =
    opts.clearTimeoutFn ??
    ((handle: TimerHandle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let fired = false;
  let remaining = opts.ms;
  let timer: TimerHandle;

  const arm = (): void => {
    const slice = Math.min(remaining, TIMEOUT_MAX);
    remaining -= slice;
    timer = schedule(() => {
      if (fired) return;
      // Not the last slice: re-arm for what is left rather than expiring.
      if (remaining > 0) {
        arm();
        return;
      }
      fired = true;
      opts.onExpire();
    }, slice);
    (timer as { unref?: () => void }).unref?.();
  };

  arm();

  return {
    stop: () => {
      fired = true;
      cancel(timer);
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
 * Resolve a millisecond bound from an env var with a default.
 *
 * Accepts a whole decimal integer or `off` (see the module doc). `0`, a
 * negative value, or `off` disables the bound and returns 0. An absent or
 * empty variable takes `defaultMs` silently; anything else takes `defaultMs`
 * and is reported once on stderr, because a ceiling the operator wrote and the
 * process ignored must not be the quietest event in the log.
 */
export function resolveBoundMs(
  envVar: string,
  defaultMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = parseBoundValue(envVar, env[envVar]);
  return parsed === REJECTED ? defaultMs : parsed;
}

/**
 * Resolve a byte bound expressed in MEGABYTES in the env var (ceilings are
 * human-set; nobody wants to count bytes) with a default in bytes. Same
 * grammar and same disable semantics as {@link resolveBoundMs}.
 */
export function resolveBoundBytes(
  envVar: string,
  defaultBytes: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const megabytes = parseBoundValue(envVar, env[envVar]);
  if (megabytes === REJECTED) return defaultBytes;
  if (megabytes === 0) return 0;
  const bytes = megabytes * 1024 * 1024;
  // A megabyte count large enough to leave the safe-integer range is not a
  // ceiling anyone meant; treat it like any other unusable value.
  if (!Number.isSafeInteger(bytes)) {
    reportRejected(envVar, env[envVar] ?? "", "megabyte count is too large");
    return defaultBytes;
  }
  return bytes;
}

/**
 * Sentinel for "this value cannot be used" — distinct from `0`, which is a
 * real answer meaning the bound is disabled. Conflating the two is how `0.5`
 * came to disable a ceiling.
 */
const REJECTED = Symbol("rejected");

/** A whole decimal integer, with an optional sign and nothing else. */
const WHOLE_INTEGER = /^[+-]?\d+$/;

/** Env vars already reported, so a resolver called per process says it once. */
const reported = new Set<string>();

function reportRejected(envVar: string, raw: string, reason: string): void {
  const key = `${envVar}=${raw}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[lifecycle] ${envVar}=${JSON.stringify(raw)} ignored: ${reason}. ` +
      "Expected a whole number of milliseconds (or megabytes), or `off`. " +
      "Using the default instead.",
  );
}

function parseBoundValue(
  envVar: string,
  raw: string | undefined,
): number | typeof REJECTED {
  if (raw === undefined) return REJECTED;
  const trimmed = raw.trim();
  // An empty variable reads as "not set", which it usually is (`FOO=`).
  if (trimmed === "") return REJECTED;
  if (trimmed.toLowerCase() === "off") return 0;

  if (!WHOLE_INTEGER.test(trimmed)) {
    reportRejected(
      envVar,
      raw,
      "not a whole number (a unit suffix, decimal point or exponent is not accepted)",
    );
    return REJECTED;
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    reportRejected(envVar, raw, "outside the safe integer range");
    return REJECTED;
  }

  return value <= 0 ? 0 : value;
}
