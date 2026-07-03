/**
 * Metered AI port — the single seam where every model call the engine makes gets
 * a per-call timeout (with retry) and a live metrics event.
 *
 * The engine routes ALL model calls through the injected {@link AgentAi} port:
 *   - `generateObject` — the evaluator ("enhancer") and the completeness judge
 *   - `stream`         — the coding worker
 *
 * Wrapping that one port therefore covers evaluator + worker + judge in a single
 * place, so the CLI status line's token/cost totals update as EACH call
 * completes (Group 8, Bug 2), and each structured call is bounded per-call and
 * retried on timeout (Group 8, Bug 1) — never a turn-level wall-clock cap.
 *
 * Streaming worker calls are NOT retried (replaying a partially-streamed call is
 * unsafe); their metrics are emitted when the stream's usage settles, and a hung
 * stream is bounded by the turn's inactivity guard + per-tool timeouts.
 */
import type {
  AgentAi,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";
import {
  callModelWithTimeout,
  DEFAULT_TIMEOUTS,
  type TimeoutConfig,
} from "./timeouts.js";
import { metricsEventFor, type MetricsEvent } from "./metrics.js";

export interface MeteredAiOptions {
  /** Timeout policy for model calls. Defaults to {@link DEFAULT_TIMEOUTS}. */
  timeouts?: TimeoutConfig;
  /** Fired with a priced {@link MetricsEvent} each time a model call completes. */
  onMetrics?: (ev: MetricsEvent) => void;
  /** Structured-log sink for `[timeout] …` lines (e.g. the debug log). */
  onLog?: (line: string) => void;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

// Process-wide monotonic call counter so every model call gets a distinct id for
// the metrics event + `[timeout]` log line. Not security-sensitive.
let callSeq = 0;
function nextCallId(): string {
  callSeq = (callSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `model-${callSeq}`;
}

/**
 * Wrap an {@link AgentAi} so every call it makes is timeout-bounded and priced
 * into a metrics event. The wrapper is transparent: it returns exactly what the
 * base port returns, only instrumented.
 */
export function createMeteredAi(base: AgentAi, opts: MeteredAiOptions = {}): AgentAi {
  const cfg = opts.timeouts ?? DEFAULT_TIMEOUTS;
  const now = opts.now ?? Date.now;

  return {
    stream(args) {
      const callId = nextCallId();
      const result = base.stream(args);
      // The worker's usage settles when the stream completes; emit metrics then.
      // A rejected usage promise (aborted/cancelled turn) is swallowed — the
      // turn's own error handling reports it; metrics just skip the dead call.
      void Promise.resolve(result.usage)
        .then((u) => {
          // AI SDK v7 nests cache reads under `inputTokenDetails` (see
          // engine.ts's identical read) — flatten to the rate card's
          // `cachedTokens` so this step's cache hit is priced at the
          // discounted rate instead of as fresh input.
          const usage = { ...u, cachedTokens: u.inputTokenDetails?.cacheReadTokens ?? 0 };
          opts.onMetrics?.(metricsEventFor(callId, "model_call", args.model, usage, now()));
        })
        .catch(() => {});
      return result;
    },

    async generateObject<T>(args: ObjectRunArgs<T>): Promise<ObjectRunResult<T>> {
      const callId = nextCallId();
      // Per-call timeout + retry. The per-attempt signal aborts the in-flight
      // request on timeout; the caller's abortSignal (user cancel) propagates
      // without a retry.
      const res = await callModelWithTimeout(
        (signal) => base.generateObject<T>({ ...args, abortSignal: signal }),
        cfg,
        { callId, model: args.model, onLog: opts.onLog },
        args.abortSignal,
      );
      // The port names this `cachedInputTokens` (ObjectRunResult.usage); the
      // rate card names the same concept `cachedTokens` — map at this seam
      // so the evaluator/judge's cache reads are priced, not dropped.
      const usage = { ...res.usage, cachedTokens: res.usage.cachedInputTokens ?? 0 };
      opts.onMetrics?.(metricsEventFor(callId, "model_call", args.model, usage, now()));
      return res;
    },
  };
}
