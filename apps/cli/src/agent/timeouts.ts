/**
 * Timeout policy for the CLI agent turn.
 *
 * ## The rule
 *
 * **Timeouts live on the individual model call, not on the turn.** A single turn
 * can legitimately make hundreds of model calls — a plan with many tasks, a
 * worker→judge revise loop, background context queries — so there is no
 * wall-clock cap on a turn at all; one would kill valid long-running work
 * mid-flight.
 *
 * What bounds a turn instead:
 *
 *   - **Per model call** — every model call is raced against
 *     {@link TimeoutConfig.perModelCallMs}. A call that hangs is aborted and
 *     retried per {@link TimeoutConfig.retry}, **without ending the turn**
 *     ({@link callModelWithTimeout}).
 *   - **Per tool call** — every tool call is bounded ({@link wrapToolsWithTimeout});
 *     bash honors its declared `timeout_ms` plus a grace margin
 *     ({@link toolWrapperTimeoutMs}), all others the standard {@link TIMEOUTS.toolMs}.
 *   - **Turn guarded by PROGRESS, not by the clock** — the optional
 *     {@link TimeoutConfig.turnInactivityMs} guard aborts the turn only when *no*
 *     model or tool call has completed within that window. Any completed call
 *     resets it, so a turn with hundreds of calls is fine as long as calls keep
 *     landing ({@link createTurnRunner}).
 *   - **Legitimate silence gets escape hatches** — {@link makeStallDetector}
 *     `shouldDefer` keeps the guard from firing while a tool/fleet is executing
 *     (bounded by its own timeout), and `probe` makes one CI call-out before an
 *     abort: a turn watching still-pending checks extends instead of dying,
 *     cumulatively capped at {@link resolveCiWaitCapMs} (2h default) so slow
 *     customer CI is survivable without blinding the hang backstop
 *     (lib/ci-wait.ts).
 *   - **Optional hard ceiling, off by default** — {@link TimeoutConfig.turnHardCeilingMs}
 *     is a last-resort safety net, `undefined` (disabled) by default. If set it
 *     must be large; it is never a few hundred seconds.
 *
 * This module is the SINGLE source of truth for CLI timeout values.
 */
import type { ToolSet } from "ai";
import { debugLog } from "../lib/debug-log.js";

// ── Error type ───────────────────────────────────────────────────────────────

/** Thrown when an agent operation exceeds its allowed duration. */
export class AgentTimeoutError extends Error {
  /** Duration that expired (ms). */
  readonly timeoutMs: number;
  /** Human label for the operation that timed out (e.g. "LLM request"). */
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    const secs = Math.round(timeoutMs / 1000);
    super(
      `⏱ Agent step timed out after ${secs}s (${operation}) — cancelled. ` +
        `Try again or narrow the request.`,
    );
    this.name = "AgentTimeoutError";
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

// ── Timeout configuration (the policy contract) ──────────────────────────────

/**
 * The timeout policy. Timeouts belong on the model call; the turn is guarded by
 * progress, never by total elapsed time.
 */
export interface TimeoutConfig {
  /** Applied to each individual model call — the real timeout. */
  perModelCallMs: number;
  /** Applied to each tool call (graph query, judge, monitor dispatch, bash…). */
  perToolCallMs?: number;
  /**
   * Progress guard, NOT a wall-clock cap. Aborts the turn only when no model or
   * tool call completes within this window; any completed call resets it. Leave
   * undefined to disable.
   */
  turnInactivityMs?: number;
  /**
   * Hard ceiling — a last-resort safety net, disabled by default. If set it must
   * be very large. Never set it to a few hundred seconds.
   */
  turnHardCeilingMs?: number;
  /** Retry policy for a timed-out model call. */
  retry: {
    maxRetries: number;
    backoffMs: number;
  };
}

/** The default timeout policy. No wall-clock turn cap; the hard ceiling is off. */
export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  perModelCallMs: 120_000,
  perToolCallMs: 120_000,
  turnInactivityMs: 300_000, // resets on every completed call; NOT total turn time
  turnHardCeilingMs: undefined,
  retry: { maxRetries: 2, backoffMs: 1_000 },
};

/** Parse an env var as a positive finite ms count, or undefined. */
function envPositiveMs(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * The effective turn-inactivity window. `OXAGEN_TURN_INACTIVITY_MS` overrides
 * the default; it stays a PROGRESS guard either way — do not set it to hours to
 * "survive CI", that's what the CI-wait probe is for (see {@link makeStallDetector}
 * `probe` and lib/ci-wait.ts).
 */
export function resolveTurnInactivityMs(): number {
  return (
    envPositiveMs("OXAGEN_TURN_INACTIVITY_MS") ??
    DEFAULT_TIMEOUTS.turnInactivityMs ??
    300_000
  );
}

/**
 * Cap on cumulative probe extensions per silent stretch (see
 * {@link makeStallDetector}). Customer CI legitimately runs for hours, so a
 * turn that a live call-out confirms is waiting on still-pending checks may
 * extend up to this long — but no further, so a wedged poll can't wait forever.
 * `OXAGEN_CI_WAIT_CAP_MS` overrides.
 */
export function resolveCiWaitCapMs(): number {
  return envPositiveMs("OXAGEN_CI_WAIT_CAP_MS") ?? TIMEOUTS.ciWaitCapMs;
}

/**
 * Fixed per-operation defaults that are not part of the tunable policy above.
 *
 * NOTE: there is deliberately **no** `turnMs` here. A turn is never capped by
 * total elapsed time — see the module docblock and {@link createTurnRunner}.
 */
export const TIMEOUTS = {
  /**
   * ms — abort a single model stream if no delta (text/reasoning/tool) arrives in
   * this window. Guards a stalled TCP connection that stays open but stops
   * delivering bytes. This is a *per-call* stall bound, not a turn bound.
   */
  llmStallMs: DEFAULT_TIMEOUTS.perModelCallMs,
  /** ms — abort a standard read/search/list/lookup tool call. */
  toolMs: 60_000,
  /**
   * ms — bash's own default timeout when the model declares no `timeout_ms`.
   * MUST mirror the bash tool's inputSchema default (agent/tools.ts).
   */
  bashDefaultMs: 120_000,
  /** ms — bash's maximum allowed `timeout_ms`. MUST mirror the inputSchema max. */
  bashMaxMs: 600_000,
  /**
   * ms — margin the long-tool wrapper adds ABOVE the tool's own timeout. The
   * tool's internal timeout (which kills the process group and returns a
   * useful message) must always fire first; the wrapper is a pure backstop
   * against a wedged tool implementation.
   */
  toolGraceMs: 30_000,
  /**
   * ms — cap on cumulative CI-wait extensions of the inactivity guard (2h).
   * Customer CI is often slow through no fault of ours; when the pre-abort
   * probe confirms checks are still pending the guard extends instead of
   * killing the turn, up to this total per silent stretch. See
   * {@link resolveCiWaitCapMs} and {@link makeStallDetector}.
   */
  ciWaitCapMs: 2 * 60 * 60 * 1_000,
} as const;

// ── Core race helper ──────────────────────────────────────────────────────────

/**
 * Race `promise` against a `ms`-millisecond deadline.
 *
 * - If `signal` is already aborted, immediately rejects with `AgentTimeoutError`.
 * - If the promise settles before the deadline, the timer is cleared — no leak.
 * - If the deadline fires first, rejects with `AgentTimeoutError`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal | null,
  label = "operation",
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new AgentTimeoutError(label, ms));
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutErr = new AgentTimeoutError(label, ms);

    const timer = setTimeout(() => {
      reject(timeoutErr);
    }, ms);
    unref(timer);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(timeoutErr);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Unref a timer so it never keeps the Node.js event loop alive on its own. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Resolve after `ms`, or reject early if `signal` aborts. Used for retry backoff. */
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    unref(timer);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AgentTimeoutError("backoff", ms));
      },
      { once: true },
    );
  });
}

// ── Per-model-call timeout + retry ────────────────────────────────────────────

/** Context for one model call, used for logging and retry accounting. */
export interface ModelCallContext {
  /** Stable id for this logical call (for the `[timeout]` log line). */
  callId: string;
  /** Model slug being called. */
  model: string;
  /** Optional structured-log sink; receives the `[timeout] scope=model_call …` line. */
  onLog?: (line: string) => void;
}

/**
 * Run a single model call bounded by `perModelCallMs`, retrying a timed-out call
 * per the retry policy. **This never ends the turn** — a hung call is aborted and
 * retried; the turn keeps running.
 *
 * `fn` receives a per-attempt `AbortSignal` that fires when THIS attempt exceeds
 * `perModelCallMs` (or the outer signal aborts). Pass it straight through to the
 * AI SDK so the in-flight request is cancelled on timeout.
 *
 * A retry emits `[timeout] scope=model_call call=<id> model=<m> ms=<n> action=retry`.
 * If the OUTER signal aborts (user cancel), the call is not retried — the abort
 * propagates.
 */
export async function callModelWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  cfg: Pick<TimeoutConfig, "perModelCallMs" | "retry">,
  ctx: ModelCallContext,
  outerSignal?: AbortSignal | null,
): Promise<T> {
  const label = `model_call:${ctx.model}`;
  const maxRetries = Math.max(0, cfg.retry.maxRetries);
  const backoffMs = Math.max(0, cfg.retry.backoffMs);

  for (let attempt = 0; ; attempt++) {
    if (outerSignal?.aborted)
      throw new AgentTimeoutError(label, cfg.perModelCallMs);

    const callController = new AbortController();
    const onOuterAbort = (): void => {
      if (!callController.signal.aborted)
        callController.abort(outerSignal?.reason);
    };
    if (outerSignal)
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => {
      if (!callController.signal.aborted) {
        callController.abort(new AgentTimeoutError(label, cfg.perModelCallMs));
      }
    }, cfg.perModelCallMs);
    unref(timer);

    try {
      const value = await fn(callController.signal);
      return value;
    } catch (err) {
      // The outer signal aborting is a user cancel — propagate, never retry.
      if (outerSignal?.aborted) throw err;
      const timedOut =
        err instanceof AgentTimeoutError ||
        (err instanceof Error && err.name === "AbortError");
      if (!timedOut || attempt >= maxRetries) throw err;
      ctx.onLog?.(
        `[timeout] scope=model_call call=${ctx.callId} model=${ctx.model} ` +
          `ms=${cfg.perModelCallMs} action=retry`,
      );
      await delay(backoffMs, outerSignal);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

// ── Turn controller (abort wiring — NO wall-clock cap) ────────────────────────

/**
 * Create an AbortController for a turn. Unlike the old implementation this does
 * **not** impose a wall-clock deadline: a turn is bounded by per-call timeouts
 * and (optionally) an inactivity guard, never by total elapsed time.
 *
 * It fires when EITHER the caller signal fires (user Esc / Ctrl-C) OR — only if
 * explicitly requested — the last-resort `hardCeilingMs` elapses. The hard
 * ceiling is off by default; if provided it should be very large.
 */
export function makeTurnController(
  callerSignal?: AbortSignal | null,
  opts?: { hardCeilingMs?: number },
): AbortController {
  const controller = new AbortController();

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
      return controller;
    }
    callerSignal.addEventListener(
      "abort",
      () => {
        if (!controller.signal.aborted) controller.abort(callerSignal.reason);
      },
      { once: true },
    );
  }

  const ceiling = opts?.hardCeilingMs;
  if (typeof ceiling === "number" && ceiling > 0 && Number.isFinite(ceiling)) {
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new AgentTimeoutError("turn hard ceiling", ceiling));
      }
    }, ceiling);
    unref(timer);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  }

  return controller;
}

// ── Inactivity / stall detector ───────────────────────────────────────────────

/** Optional escape hatches consulted when the stall window expires. */
export interface StallDetectorOptions {
  /**
   * Consulted first when the window expires. Return true to defer — reschedule
   * the window instead of firing. Use for "a tool is executing right now":
   * an in-flight tool is bounded by its own timeout and produces no events
   * until it returns, so silence during it is expected, not a stall.
   */
  shouldDefer?: () => boolean;
  /**
   * Last-chance async check-in before firing (the CI-wait call-out). Runs only
   * when `shouldDefer` did not defer. Resolving true extends the window by one
   * more `idleMs`; false — or a throw — lets `onIdle` fire. Cumulative
   * extensions within one silent stretch are capped by `probeCapMs`; any real
   * progress (`reset()`) zeroes the accumulator. While the probe is in flight
   * a `reset()` or `stop()` wins — its verdict is then discarded.
   */
  probe?: () => Promise<boolean> | boolean;
  /** Cap on cumulative probe extensions (ms). Default {@link resolveCiWaitCapMs}. */
  probeCapMs?: number;
  /** Structured-log sink for defer/extend/abort decisions. */
  onLog?: (line: string) => void;
}

/**
 * A progress guard. Fires `onIdle` if `reset()` is not called within `idleMs`.
 * Call `reset()` on every unit of progress (a completed model/tool call, a
 * stream delta) to push the deadline forward; `stop()` when the turn ends.
 *
 * This is the primitive behind both the per-stream stall bound and the
 * turn-level inactivity guard — the difference is only the window and what
 * counts as "progress". `opts` adds two escape hatches for legitimate silence:
 * defer while a tool is executing, and probe (e.g. "is CI still pending?")
 * before aborting — see {@link StallDetectorOptions}.
 */
export function makeStallDetector(
  idleMs: number,
  onIdle: () => void,
  opts?: StallDetectorOptions,
): { reset: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Bumped on every reset(); a probe that resolves after real progress landed
  // (or after another expiry) must not act on a stale verdict.
  let generation = 0;
  // Cumulative probe extensions in the CURRENT silent stretch; reset() zeroes it.
  let extendedMs = 0;
  const probeCapMs = opts?.probeCapMs ?? resolveCiWaitCapMs();

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onExpired, idleMs);
    unref(timer as ReturnType<typeof setTimeout>);
  }

  function onExpired(): void {
    if (stopped) return;
    if (opts?.shouldDefer?.()) {
      opts.onLog?.(`[timeout] scope=stall action=defer idle_ms=${idleMs}`);
      schedule();
      return;
    }
    if (opts?.probe && extendedMs < probeCapMs) {
      const gen = ++generation;
      Promise.resolve()
        .then(opts.probe)
        .then(
          (stillWaiting) => {
            if (stopped || generation !== gen) return; // progress won the race
            if (stillWaiting) {
              extendedMs += idleMs;
              opts.onLog?.(
                `[timeout] scope=stall action=extend extended_ms=${extendedMs} cap_ms=${probeCapMs}`,
              );
              schedule();
            } else {
              onIdle();
            }
          },
          () => {
            if (!stopped && generation === gen) onIdle();
          },
        );
      return;
    }
    onIdle();
  }

  function reset(): void {
    if (stopped) return;
    generation++;
    extendedMs = 0;
    schedule();
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  schedule();
  return { reset, stop };
}

// ── Turn runner (progress-based; the contract implementation) ─────────────────

/** How a turn ended: it finished, or a guard aborted it. */
export type TurnEndReason = "completed" | "inactivity" | "hard_ceiling";

/** A single model call carries its own deadline; the turn does not impose one. */
export interface ModelCall {
  id: string;
  model: string;
  /** Defaults to {@link TimeoutConfig.perModelCallMs}. */
  timeoutMs: number;
  startedAt: number;
}

/** Emitted when a model or tool call completes — resets the inactivity guard. */
export interface ProgressEvent {
  kind: "model_call_done" | "tool_call_done";
  callId: string;
  at: number;
}

/**
 * Watches a turn by PROGRESS, not wall-clock:
 *  - a completed model/tool call emits a {@link ProgressEvent} via `onProgress`
 *  - the inactivity guard (if configured) resets on every ProgressEvent
 *  - the turn aborts only on inactivity or the optional hard ceiling
 */
export interface TurnRunner {
  onProgress(ev: ProgressEvent): void;
  run(work: () => Promise<void>): Promise<TurnEndReason>;
}

/**
 * A {@link TurnRunner} that also exposes the primitives every live surface used
 * to hand-roll around {@link makeTurnController} + {@link makeStallDetector}:
 * its abort signal, a progress reset, in-flight-tool tracking, and a stop hook.
 */
export interface RunningTurnRunner extends TurnRunner {
  /** Pass this to the turn's model/tool calls (and `buildTurnExtras`) so guards can cancel them. */
  readonly signal: AbortSignal;
  /**
   * Reset the inactivity guard AND advance the idle clock. Call on every unit of
   * progress — a stream delta (text/reasoning), a stage, or a tool start/end.
   * The lightweight sibling of {@link onProgress} for surfaces that don't build a
   * {@link ProgressEvent}.
   */
  noteProgress(): void;
  /**
   * Note that a tool started executing. The default `shouldDefer` keeps the guard
   * from firing while any tool is in flight — an executing tool is bounded by its
   * own timeout and produces no events until it returns, so silence during it is
   * expected, not a stall.
   */
  noteToolStart(): void;
  /** Note that a tool finished (clamped ≥ 0). */
  noteToolEnd(): void;
  /** Stop the inactivity guard. Call in the turn's `finally`. */
  stop(): void;
}

/** Escape-hatch wiring for the turn's inactivity guard (see {@link makeStallDetector}). */
export interface TurnRunnerStallOptions {
  /**
   * Consulted first when the window expires. Return true to defer instead of
   * firing. Defaults to the runner's own in-flight-tool count (`> 0`) — override
   * only to add extra deferral signals (e.g. a fleet still executing). Overriding
   * REPLACES the default, so fold the tool count back in if you still need it.
   */
  shouldDefer?: () => boolean;
  /**
   * Last-chance async check-in before firing (the CI-wait call-out). Omit for
   * surfaces that must never sit silent (e.g. the PR-fix loop, whose CI waiting
   * happens outside the turn).
   */
  probe?: () => Promise<boolean> | boolean;
  /** Cap on cumulative probe extensions (ms). Default {@link resolveCiWaitCapMs}. */
  probeCapMs?: number;
}

/** Options for {@link createTurnRunner}. */
export interface TurnRunnerOptions {
  /** Structured-log sink for the turn guard AND the stall defer/extend/abort lines. */
  onLog?: (line: string) => void;
  /** Caller signal (Esc / Ctrl-C, or a parent session controller) chained into the turn. */
  callerSignal?: AbortSignal | null;
  /** Inactivity-guard escape hatches. Omit for a bare progress guard. */
  stall?: TurnRunnerStallOptions;
}

/**
 * Build a progress-guarded turn runner. **This is THE canonical way to run a
 * turn** — it composes {@link makeTurnController} + {@link makeStallDetector} so
 * no live surface has to hand-roll that pairing. Every headless and interactive
 * loop routes through it: `repl/one-shot.ts` (both entrypoints),
 * `agent/pr-fix-runner.ts`, `agent/planner.ts` (controller-only),
 * `sessions/runner.ts`, and `repl/interactive.tsx` (whose fleet-aware
 * `shouldDefer` comes in via {@link TurnRunnerStallOptions}).
 *
 * The turn completes as long as calls keep landing; it aborts only when no
 * progress (a stream delta, stage, or tool start/end — via {@link noteProgress})
 * lands within `turnInactivityMs` (progress-based, deferred while a tool is in
 * flight and after a live CI-wait probe), or, if set, when the last-resort
 * `turnHardCeilingMs` elapses. The inactivity guard is armed eagerly at
 * construction — the same moment every surface used to arm its hand-rolled
 * detector — so `signal` / `noteProgress` / `stop` can be used directly around a
 * `runTurn` call without calling {@link run}. `run(work)` remains for callers
 * that want the runner to own the race and hand back a {@link TurnEndReason}.
 *
 * Leaving `turnInactivityMs` undefined builds a controller-only runner (no guard)
 * — the drop-in for a plain {@link makeTurnController} that still wires the
 * caller signal and optional hard ceiling.
 */
export function createTurnRunner(
  cfg: Pick<TimeoutConfig, "turnInactivityMs" | "turnHardCeilingMs">,
  opts?: TurnRunnerOptions,
): RunningTurnRunner {
  const controller = makeTurnController(opts?.callerSignal, {
    hardCeilingMs: cfg.turnHardCeilingMs,
  });
  let endReason: TurnEndReason | null = null;
  let lastProgressAt = Date.now();
  let inFlightTools = 0;

  // A hard-ceiling abort carries an AgentTimeoutError reason; surface it as the
  // hard_ceiling end reason if it fired before any inactivity abort.
  controller.signal.addEventListener(
    "abort",
    () => {
      if (
        endReason === null &&
        controller.signal.reason instanceof AgentTimeoutError
      ) {
        endReason = "hard_ceiling";
      }
    },
    { once: true },
  );

  // Arm the inactivity guard eagerly — matching every live surface, which builds
  // its stall detector the moment the turn's port is assembled, not lazily on run.
  let guard: { reset: () => void; stop: () => void } | null = null;
  const window = cfg.turnInactivityMs;
  if (typeof window === "number" && window > 0) {
    guard = makeStallDetector(
      window,
      () => {
        if (!controller.signal.aborted) {
          const idleMs = Date.now() - lastProgressAt;
          opts?.onLog?.(
            `[timeout] scope=turn reason=inactivity idle_ms=${idleMs}`,
          );
          endReason = "inactivity";
          controller.abort(new AgentTimeoutError("turn inactivity", window));
        }
      },
      {
        shouldDefer: opts?.stall?.shouldDefer ?? (() => inFlightTools > 0),
        ...(opts?.stall?.probe ? { probe: opts.stall.probe } : {}),
        ...(opts?.stall?.probeCapMs !== undefined
          ? { probeCapMs: opts.stall.probeCapMs }
          : {}),
        ...(opts?.onLog ? { onLog: opts.onLog } : {}),
      },
    );
  }

  function noteProgress(): void {
    lastProgressAt = Date.now();
    guard?.reset();
  }

  function onProgress(ev: ProgressEvent): void {
    lastProgressAt = ev.at;
    guard?.reset();
  }

  function noteToolStart(): void {
    inFlightTools++;
  }

  function noteToolEnd(): void {
    inFlightTools = Math.max(0, inFlightTools - 1);
  }

  function stop(): void {
    guard?.stop();
  }

  async function run(work: () => Promise<void>): Promise<TurnEndReason> {
    const aborted = new Promise<"aborted">((resolve) => {
      if (controller.signal.aborted) resolve("aborted");
      else
        controller.signal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
    });

    let workErr: unknown = null;
    const done = work().then(
      () => "done" as const,
      (err: unknown) => {
        workErr = err;
        return "error" as const;
      },
    );

    try {
      const outcome = await Promise.race([done, aborted]);
      if (outcome === "done") return "completed";
      if (outcome === "aborted") return endReason ?? "completed";
      // work threw: if a guard fired, report that; otherwise propagate.
      if (endReason) return endReason;
      throw workErr;
    } finally {
      stop();
    }
  }

  return {
    onProgress,
    noteProgress,
    noteToolStart,
    noteToolEnd,
    run,
    stop,
    signal: controller.signal,
  };
}

// ── Tool timeout wrapping ─────────────────────────────────────────────────────

/** Category of tool for choosing a default timeout. */
export type ToolTimeoutCategory = "standard" | "long";

/**
 * Choose the timeout category for a tool by name. `bash` runs builds/tests/git
 * ops that legitimately take minutes; everything else should be fast.
 */
export function toolTimeoutCategory(toolName: string): ToolTimeoutCategory {
  return toolName === "bash" ? "long" : "standard";
}

/**
 * The wrapper deadline for one tool call. Long tools (bash) declare their own
 * timeout via `timeout_ms` — the tool's INTERNAL timeout (which kills the
 * process group and returns a real message) is authoritative, so the wrapper
 * sits a grace period above the declared/default value and never contradicts
 * it — a model that asks for a 10-minute test run must not be killed at 4
 * minutes by a fixed wrapper deadline. Exported for tests.
 */
export function toolWrapperTimeoutMs(name: string, input: unknown): number {
  if (toolTimeoutCategory(name) === "long") {
    const declared = (input as { timeout_ms?: unknown } | null)?.timeout_ms;
    const own = Math.min(
      typeof declared === "number" && Number.isFinite(declared)
        ? declared
        : TIMEOUTS.bashDefaultMs,
      TIMEOUTS.bashMaxMs,
    );
    return own + TIMEOUTS.toolGraceMs;
  }
  return TIMEOUTS.toolMs;
}

/**
 * Wrap every tool execute in a per-call timeout appropriate for its category
 * (long tools honor their declared `timeout_ms` — see
 * {@link toolWrapperTimeoutMs}). Returns a new ToolSet; never mutates the
 * input. A timed-out tool surfaces as a tool-result string (not a throw) so
 * the turn stays alive and the model can adapt.
 */
export function wrapToolsWithTimeout(
  tools: ToolSet,
  signal?: AbortSignal | null,
): ToolSet {
  const out: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const exec = toolDef.execute;
    if (!exec) {
      out[name] = toolDef;
      continue;
    }

    const category = toolTimeoutCategory(name);

    out[name] = {
      ...toolDef,
      execute: (input: unknown, options: unknown): Promise<unknown> => {
        const ms = toolWrapperTimeoutMs(name, input);
        return withTimeout(
          Promise.resolve(
            (exec as (i: unknown, o: unknown) => unknown)(input, options),
          ),
          ms,
          signal,
          `tool:${name}`,
        ).catch((err: unknown) => {
          // A hung tool is THE most common way a turn appears "stuck". It's
          // converted to a tool-result string (not a throw) so the turn survives,
          // which means it never reaches the turn-level error path — log it here or
          // it vanishes from cli.output entirely.
          if (err instanceof AgentTimeoutError) {
            void debugLog("error", "turn.tool-timeout", {
              tool: name,
              category,
              timeoutMs: ms,
              message: err.message,
            });
            return err.message;
          }
          // A tool that threw a real error: capture the exception (name/message/
          // stack via debugLog's Error handling) before re-throwing to the turn.
          void debugLog("error", "turn.tool-throw", { tool: name, error: err });
          throw err;
        });
      },
    };
  }
  return out;
}
