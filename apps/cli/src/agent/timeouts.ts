/**
 * Timeout configuration and utilities for the CLI agent turn.
 *
 * Every long operation — LLM requests, tool calls, the overall turn — must be
 * bounded so that a stalled stream, a hanging shell command, or an unresponsive
 * model never leaves the user staring at "Thinking… 249s" with no way out short
 * of killing the process.
 *
 * This module is the SINGLE source of truth for all timeout values. The TUI
 * imports {@link AGENT_TURN_TIMEOUT_MS} to compute an ETA / time-remaining
 * indicator during a turn.
 */
import type { ToolSet } from "ai";

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

// ── Constants — change here, propagate everywhere ────────────────────────────

/**
 * All timeout durations in one place. These are the defaults; individual call
 * sites may shorten but should not exceed these values without a comment.
 */
export const TIMEOUTS = {
  /**
   * ms — abort the LLM stream if no text delta or tool call arrives in this
   * window. Guards against a stalled TCP connection that stays open indefinitely.
   */
  llmStallMs: 60_000,
  /**
   * ms — abort a standard read/search/list/lookup tool call (read_file, glob,
   * grep, list_dir, code_graph). These should always complete quickly.
   */
  toolMs: 60_000,
  /**
   * ms — abort a long-running tool call (bash builds, tests, git ops). The bash
   * tool already accepts a model-supplied timeout_ms; this is a hard outer cap.
   */
  toolLongMs: 240_000,
  /**
   * ms — backstop for the entire agent turn (LLM calls + all tool rounds). If
   * the turn is still running after this window, everything is aborted and the
   * user sees a clear message.
   */
  turnMs: 300_000,
} as const;

/**
 * The per-turn backstop in milliseconds — exported so the TUI can import it to
 * show an ETA / time-remaining indicator.
 *
 * @example
 *   import { AGENT_TURN_TIMEOUT_MS } from "../agent/timeouts.js";
 *   const remaining = AGENT_TURN_TIMEOUT_MS - (Date.now() - turnStartedAt);
 */
export const AGENT_TURN_TIMEOUT_MS = TIMEOUTS.turnMs;

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Race `promise` against a `ms`-millisecond deadline.
 *
 * - If `signal` is already aborted, immediately rejects with `AgentTimeoutError`.
 * - If the promise settles before the deadline, the timer is cleared — no leak.
 * - If the deadline fires first, rejects with `AgentTimeoutError`.
 *
 * @param promise  The operation to bound.
 * @param ms       Deadline in milliseconds.
 * @param signal   Optional abort signal that also cancels the promise early.
 * @param label    Human label used in the error message (e.g. "LLM request").
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal | null,
  label = "operation",
): Promise<T> {
  // Short-circuit: signal already aborted before we even start.
  if (signal?.aborted) {
    return Promise.reject(new AgentTimeoutError(label, ms));
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutErr = new AgentTimeoutError(label, ms);

    const timer = setTimeout(() => {
      reject(timeoutErr);
    }, ms);
    // Unref so this timer never keeps the Node.js event loop alive on its own.
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }

    // Mirror the abort signal: if it fires before the promise settles, reject
    // with the same timeout error so the caller sees a consistent type.
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

// ── Turn controller ───────────────────────────────────────────────────────────

/**
 * Create an AbortController that fires as soon as EITHER:
 *   1. `callerSignal` fires (e.g. the user pressed Esc / Ctrl-C), or
 *   2. `deadlineMs` elapses (the per-turn backstop).
 *
 * Pass `controller.signal` to every sub-operation (streamText, tool executes,
 * hook runners) so they all cancel on the first trigger.
 *
 * The deadline timer is `unref()`-ed — it will never prevent the Node.js
 * process from exiting normally — and is cleared automatically when the signal
 * aborts, so there are no leaks.
 *
 * @param callerSignal  The outer cancellation signal (user Esc / Ctrl-C).
 * @param deadlineMs    Per-turn wall-clock limit (default: {@link TIMEOUTS.turnMs}).
 */
export function makeTurnController(
  callerSignal?: AbortSignal | null,
  deadlineMs: number = TIMEOUTS.turnMs,
): AbortController {
  const controller = new AbortController();

  // Propagate the caller's signal immediately.
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

  // Wire the deadline timer.
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new AgentTimeoutError("turn deadline", deadlineMs));
    }
  }, deadlineMs);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  // Clear the timer when the signal fires (from any cause) so there is no leak.
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  return controller;
}

// ── Stall detector ────────────────────────────────────────────────────────────

/**
 * A stall detector wraps a streaming operation and aborts it if no progress
 * (no stream delta) arrives within `stallMs`. Call `reset()` each time a
 * delta arrives to push the deadline forward. Call `stop()` when the stream
 * finishes to cancel the timer.
 *
 * `onStall` is called exactly once if the timer fires without a reset.
 *
 * @param stallMs  Window in ms; if no progress for this long, call `onStall`.
 * @param onStall  Callback invoked when a stall is detected (e.g. abort the turn).
 */
export function makeStallDetector(
  stallMs: number,
  onStall: () => void,
): { reset: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleStall(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) onStall();
    }, stallMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  function reset(): void {
    if (stopped) return;
    scheduleStall();
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Start the initial countdown.
  scheduleStall();

  return { reset, stop };
}

// ── Tool timeout wrapping ─────────────────────────────────────────────────────

/** Category of tool for choosing a default timeout. */
export type ToolTimeoutCategory = "standard" | "long";

/**
 * Choose the appropriate timeout category for a tool by name.
 * `bash` runs builds/tests/git ops that legitimately take minutes; every
 * other tool (reads, searches, lookups) should be fast.
 */
export function toolTimeoutCategory(toolName: string): ToolTimeoutCategory {
  return toolName === "bash" ? "long" : "standard";
}

/**
 * Wrap every tool execute in a timeout appropriate for its category. Returns a
 * new ToolSet; never mutates the input.
 *
 * Tool timeouts surface to the model as a tool-result string (not a throw) so
 * that a slow tool aborts cleanly while the turn itself can still finish and
 * explain the situation to the user. If `signal` is already aborted when the
 * execute is called, the timeout fires immediately.
 *
 * @param tools   The tool set to wrap (e.g. from `wrapToolsWithGate`).
 * @param signal  The turn-level signal; a tool call that outlives the turn is
 *                cancelled as soon as the turn signal fires.
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
    const ms = category === "long" ? TIMEOUTS.toolLongMs : TIMEOUTS.toolMs;

    out[name] = {
      ...toolDef,
      execute: (input: unknown, options: unknown): Promise<unknown> =>
        withTimeout(
          // exec returns `Promise<unknown>` (the AI SDK types it as returning
          // the execute result which may not be a promise in all TS builds, but
          // tool executes are always async in practice — Promise.resolve is safe).
          Promise.resolve((exec as (i: unknown, o: unknown) => unknown)(input, options)),
          ms,
          signal,
          `tool:${name}`,
        ).catch((err: unknown) => {
          // A timeout on a tool call surfaces as a string result the model reads.
          // The turn stays alive so the model can explain the situation or try a
          // different approach. All other errors are rethrown to the AI SDK.
          if (err instanceof AgentTimeoutError) return err.message;
          throw err;
        }),
    };
  }
  return out;
}
