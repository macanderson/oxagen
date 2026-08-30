/**
 * circuit-breaker.ts — a small, dependency-free circuit breaker for the shared
 * external-dependency client paths (Neo4j, Stripe, ClickHouse).
 *
 * Without it, a degraded external dependency gets hammered by every request —
 * no fail-fast, no bulkhead. One slow or erroring Neo4j or Stripe call would
 * pile up connection attempts and stall the whole process. The breaker fails
 * fast once a dependency looks down, gives it room to recover, and makes the
 * trip observable.
 *
 * Design:
 *  - Pure state machine, no npm dependency (bloat/vendor policy: no breaker lib).
 *  - Three states — closed (calls flow), open (fail fast), half-open (one probe).
 *  - Per-key registry so each dependency trips independently (a down Stripe must
 *    not fail-fast Neo4j).
 *  - A `CircuitOpenError` callers can distinguish from a real dependency error.
 *  - An injected `onTransition` sink so the wiring layer decides HOW a trip is
 *    surfaced (ClickHouse event for Neo4j/Stripe; stderr for the ClickHouse
 *    breaker itself, which cannot write to the store that is down).
 *
 * The core here never imports the ClickHouse client — emission is wired by the
 * caller via `onTransition` — so this file stays dependency-free and trivially
 * testable with an injectable clock.
 */

/** Breaker states. `closed` = healthy, `open` = failing fast, `half-open` = probing recovery. */
export type BreakerState = "closed" | "open" | "half-open";

/** A state transition, handed to the (optional) `onTransition` sink. Never thrown. */
export interface BreakerTransition {
  /** Per-dependency key (e.g. "neo4j", "stripe", "clickhouse"). */
  key: string;
  from: BreakerState;
  to: BreakerState;
  /** Consecutive-failure count at the moment of transition. */
  failureCount: number;
  /** Epoch ms of the transition (from the breaker's injected clock). */
  at: number;
  /** Message of the error that drove an open/reopen transition, if any. */
  error?: string;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures while `closed` that trip the breaker `open`. Default 5. */
  failureThreshold?: number;
  /** Ms the breaker stays `open` before allowing a single half-open probe. Default 30_000. */
  resetTimeoutMs?: number;
  /** Consecutive successes while `half-open` that close the breaker. Default 1. */
  successThreshold?: number;
  /** Injectable clock (epoch ms). Defaults to Date.now — overridden in tests. */
  now?: () => number;
  /** Called on every state transition. MUST NOT throw — the breaker guards it. */
  onTransition?: (t: BreakerTransition) => void;
}

/**
 * Thrown by `CircuitBreaker.exec` when the breaker is `open` and fails fast.
 * Callers distinguish it from a genuine dependency error via `instanceof
 * CircuitOpenError` or the stable `code === "CIRCUIT_OPEN"`.
 */
export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN" as const;
  constructor(
    readonly key: string,
    /** Ms until the breaker will allow a probe again. */
    readonly retryAfterMs: number,
  ) {
    super(
      `circuit breaker "${key}" is open — failing fast (retry in ${retryAfterMs}ms)`,
    );
    this.name = "CircuitOpenError";
  }
}

/** Type guard for the fail-fast error. */
export function isCircuitOpenError(err: unknown): err is CircuitOpenError {
  return err instanceof CircuitOpenError;
}

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 1,
} as const;

/**
 * A single breaker instance. Prefer `getBreaker(key)` over constructing directly
 * so a dependency shares ONE breaker process-wide (per-key isolation only works
 * if every call path routes through the same instance).
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  /** Consecutive successes accrued while half-open. */
  private probeSuccesses = 0;
  /** Epoch ms the breaker last opened; drives the reset-timeout window. */
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;
  private readonly onTransition?: (t: BreakerTransition) => void;

  constructor(
    readonly key: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
    this.successThreshold = opts.successThreshold ?? DEFAULTS.successThreshold;
    this.now = opts.now ?? Date.now;
    this.onTransition = opts.onTransition;
  }

  /** Current state — for observability/tests. */
  getState(): BreakerState {
    // Surface a matured open→half-open transition to a reader even without a call.
    if (
      this.state === "open" &&
      this.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      return "half-open";
    }
    return this.state;
  }

  /**
   * Run `fn` under the breaker.
   *  - closed: run; reset on success, count failures and trip at threshold.
   *  - open: if the reset window has elapsed, move to half-open and let this
   *    call through; otherwise fail fast with `CircuitOpenError`.
   *  - half-open: run the call; a success closes the breaker (after
   *    successThreshold), a failure reopens it immediately.
   *
   * Half-open admits every concurrent caller, not a single probe. Once the
   * reset window elapses the state flips to `half-open` synchronously and any
   * further call sees `half-open` and runs straight through — there is no
   * in-flight-probe counter. On a still-down dependency that means one burst of
   * traffic reaches it per `resetTimeoutMs` before the first failure reopens the
   * breaker. That is bounded and acceptable for the telemetry/Neo4j/Stripe paths
   * this guards; a dependency that cannot absorb such a burst needs a real
   * single-flight probe here.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.key, this.resetTimeoutMs - elapsed);
      }
      // Reset window elapsed — move to half-open and let calls through again.
      this.transition("half-open", this.failures);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      // A fail-fast from a NESTED breaker of the same key shouldn't be counted as
      // a dependency failure, but each breaker instance is per-key so that cannot
      // happen here; any thrown error is a real dependency failure.
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.successThreshold) {
        this.failures = 0;
        this.probeSuccesses = 0;
        this.transition("closed", 0);
      }
      return;
    }
    // Closed: any success clears accumulated failures.
    this.failures = 0;
  }

  private onFailure(err: unknown): void {
    this.failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    if (this.state === "half-open") {
      // A failed probe reopens immediately.
      this.probeSuccesses = 0;
      this.openedAt = this.now();
      this.transition("open", this.failures, message);
      return;
    }
    if (this.state === "closed" && this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition("open", this.failures, message);
    }
  }

  private transition(
    to: BreakerState,
    failureCount: number,
    error?: string,
  ): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (this.onTransition) {
      // The sink must never destabilise the breaker — a telemetry hiccup can't
      // be allowed to throw out of exec().
      try {
        this.onTransition({
          key: this.key,
          from,
          to,
          failureCount,
          at: this.now(),
          error,
        });
      } catch {
        // swallow — breaker health must not depend on the emitter
      }
    }
  }

  /** Test/teardown helper: force the breaker back to a healthy closed state. */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.probeSuccesses = 0;
    this.openedAt = 0;
  }
}

// ── Per-key registry ─────────────────────────────────────────────────────────
//
// Every dependency shares ONE breaker process-wide. The registry is keyed by the
// dependency name; options are applied the first time a key is requested (the
// wiring layer for each client owns those options).

const registry = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the process-wide breaker for `key`. `opts` are used
 * only on first creation for a given key — later calls return the existing
 * instance so per-key isolation holds across every call path.
 */
export function getBreaker(
  key: string,
  opts?: CircuitBreakerOptions,
): CircuitBreaker {
  let b = registry.get(key);
  if (!b) {
    b = new CircuitBreaker(key, opts);
    registry.set(key, b);
  }
  return b;
}

/** Clear the registry — tests only, so one test's breakers don't leak into the next. */
export function __resetBreakerRegistry(): void {
  registry.clear();
}
