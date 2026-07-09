/**
 * Live session-metrics accumulator + event bus for the CLI status line.
 *
 * Every model call and tool call in a turn reports a {@link MetricsEvent}; this
 * module folds those events into running per-turn and per-session totals
 * (overall and broken out by model) and fans out a throttled stream of
 * snapshots to subscribers — the TUI status line renders from that stream so
 * the live token/cost readout never needs to poll or re-derive state itself.
 *
 * Throttling matters because a single LLM stream can emit dozens of token
 * deltas per second; re-rendering the status line on every one would be
 * wasted work. {@link MetricsBus.record} coalesces bursts into at most one
 * notify per `throttleMs`, but always fires immediately once `throttleTokens`
 * have accumulated since the last notify so a big burst is never hidden
 * behind the timer.
 */
import { estimateCostUsd, type TokenUsage } from "./rate-card.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One priced model or tool call, as reported by the agent loop. */
export interface MetricsEvent {
  /** Correlates this event back to the originating call (LLM step or tool invocation). */
  callId: string;
  kind: "model_call" | "tool_call";
  /** Gateway model slug (e.g. "anthropic/claude-sonnet-5"). */
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Subset of `tokensIn` served from the provider's prompt cache (a cache "hit"). */
  cachedTokens: number;
  /** Cost for THIS call only — already priced (cache-discounted), not cumulative. */
  costUsd: number;
  /** Epoch ms the event was recorded. */
  at: number;
}

/** Running token/cost totals for a single model within the current window. */
export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
}

/**
 * Accumulated usage for the status line: per-turn (resets each turn) and
 * per-session (persists for the life of the process), plus a per-model
 * breakdown that always reflects session-lifetime totals.
 */
export interface SessionMetrics {
  turnTokensIn: number;
  turnTokensOut: number;
  turnCachedTokens: number;
  turnCostUsd: number;
  sessionTokensIn: number;
  sessionTokensOut: number;
  sessionCachedTokens: number;
  sessionCostUsd: number;
  /**
   * Estimated output tokens (~chars/4) of the model call streaming RIGHT NOW.
   * The AI SDK only reports real usage when a stream finishes, so without this
   * the burn readout sits flat for the whole call and then jumps. Displays add
   * it to `turnTokensOut`/`sessionTokensOut`; it zeroes the moment the call's
   * settled usage is recorded, so totals always converge on the real figures.
   */
  streamTokensOut: number;
  byModel: Record<string, ModelUsage>;
}

/** The live metrics accumulator + subscription bus. */
export interface MetricsBus {
  /** Fold an event into turn/session/byModel totals and notify (throttled). */
  record(ev: MetricsEvent): void;
  /**
   * Report streamed output characters from the in-flight model call (text +
   * reasoning deltas). Accumulates into the live `streamTokensOut` estimate
   * so the burn readout ticks WHILE tokens stream, not only at call settle.
   */
  noteStreamChars(chars: number): void;
  /** Subscribe to snapshot updates. Returns an unsubscribe function. */
  subscribe(handler: (m: SessionMetrics) => void): () => void;
  /** Current totals, deep-copied so callers can't mutate internal state. */
  snapshot(): SessionMetrics;
  /** Zero the turn totals (session totals + byModel persist) and notify. */
  startTurn(): void;
  /** Cancel any pending throttle timer and notify synchronously right now. */
  flush(): void;
}

/** Tunables for {@link createMetricsBus}. */
export interface MetricsBusOptions {
  /** Minimum ms between notifications while events keep arriving. Default 100. */
  throttleMs?: number;
  /**
   * Token count that, once accumulated since the last notify, forces an
   * immediate notification even inside the throttle window. Default 200.
   */
  throttleTokens?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_THROTTLE_MS = 100;
const DEFAULT_THROTTLE_TOKENS = 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A zeroed {@link ModelUsage}. */
function emptyModelUsage(): ModelUsage {
  return { tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: 0 };
}

/** A zeroed {@link SessionMetrics}. */
function emptyMetrics(): SessionMetrics {
  return {
    turnTokensIn: 0,
    turnTokensOut: 0,
    turnCachedTokens: 0,
    turnCostUsd: 0,
    sessionTokensIn: 0,
    sessionTokensOut: 0,
    sessionCachedTokens: 0,
    sessionCostUsd: 0,
    streamTokensOut: 0,
    byModel: {},
  };
}

/** Deep-copy a {@link SessionMetrics} so subscribers can't mutate the bus's state. */
function cloneMetrics(m: SessionMetrics): SessionMetrics {
  const byModel: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(m.byModel)) {
    byModel[model] = { ...usage };
  }
  return { ...m, byModel };
}

/**
 * `.unref()` a Node timer so a pending throttle window never keeps the
 * process alive (setTimeout's return type differs between DOM and Node lib
 * typings, so this is guarded rather than typed as NodeJS.Timeout directly).
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a fresh {@link MetricsBus} with independent state. */
export function createMetricsBus(opts?: MetricsBusOptions): MetricsBus {
  const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const throttleTokens = opts?.throttleTokens ?? DEFAULT_THROTTLE_TOKENS;

  const metrics = emptyMetrics();
  const subscribers = new Set<(m: SessionMetrics) => void>();
  /** Raw streamed chars of the in-flight call, behind `streamTokensOut` (~chars/4). */
  let streamChars = 0;

  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  // Seeded to creation time (not 0) so the very first record() after startup
  // isn't treated as "throttleMs have already elapsed" and fired unthrottled.
  let lastNotifyAt = Date.now();
  /** Tokens accumulated (in + out) since the last successful notify. */
  let tokensSinceNotify = 0;

  /** Call every subscriber with a fresh snapshot; isolate throwing handlers. */
  function notifyNow(): void {
    const snap = cloneMetrics(metrics);
    for (const handler of subscribers) {
      try {
        handler(snap);
      } catch {
        // A misbehaving subscriber must never break the others or the bus.
      }
    }
    lastNotifyAt = Date.now();
    tokensSinceNotify = 0;
  }

  /** Cancel any scheduled trailing notify. */
  function clearPending(): void {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  }

  /**
   * Schedule (or leave scheduled) a trailing notify so the last update within
   * a throttle window is never dropped.
   */
  function scheduleTrailing(remainingMs: number): void {
    if (pendingTimer !== undefined) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      notifyNow();
    }, remainingMs);
    unrefTimer(pendingTimer);
  }

  /**
   * Notify subscribers, throttled: at most once per `throttleMs`, except a
   * burst of at least `throttleTokens` tokens since the last notify always
   * fires immediately.
   */
  function notifyThrottled(): void {
    const now = Date.now();
    const elapsed = now - lastNotifyAt;
    if (tokensSinceNotify >= throttleTokens || elapsed >= throttleMs) {
      clearPending();
      notifyNow();
      return;
    }
    scheduleTrailing(throttleMs - elapsed);
  }

  function record(ev: MetricsEvent): void {
    const tokensIn = ev.tokensIn;
    const tokensOut = ev.tokensOut;
    const cachedTokens = ev.cachedTokens;

    // The call's real usage has settled — drop the live estimate so displays
    // (which render `total + streamTokensOut`) converge on the exact figures
    // instead of double-counting the just-recorded output.
    if (ev.kind === "model_call") {
      streamChars = 0;
      metrics.streamTokensOut = 0;
    }

    metrics.turnTokensIn += tokensIn;
    metrics.turnTokensOut += tokensOut;
    metrics.turnCachedTokens += cachedTokens;
    metrics.turnCostUsd += ev.costUsd;
    metrics.sessionTokensIn += tokensIn;
    metrics.sessionTokensOut += tokensOut;
    metrics.sessionCachedTokens += cachedTokens;
    metrics.sessionCostUsd += ev.costUsd;

    const usage = metrics.byModel[ev.model] ?? emptyModelUsage();
    usage.tokensIn += tokensIn;
    usage.tokensOut += tokensOut;
    usage.cachedTokens += cachedTokens;
    usage.costUsd += ev.costUsd;
    metrics.byModel[ev.model] = usage;

    tokensSinceNotify += tokensIn + tokensOut;
    notifyThrottled();
  }

  function subscribe(handler: (m: SessionMetrics) => void): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function snapshot(): SessionMetrics {
    return cloneMetrics(metrics);
  }

  function noteStreamChars(chars: number): void {
    if (chars <= 0) return;
    streamChars += chars;
    // ~4 chars per token — the same coarse estimate the thinking indicator
    // uses; close enough for a live burn readout that reconciles at settle.
    const estimate = Math.round(streamChars / 4);
    const delta = estimate - metrics.streamTokensOut;
    if (delta <= 0) return;
    metrics.streamTokensOut = estimate;
    tokensSinceNotify += delta;
    notifyThrottled();
  }

  function startTurn(): void {
    metrics.turnTokensIn = 0;
    metrics.turnTokensOut = 0;
    metrics.turnCachedTokens = 0;
    metrics.turnCostUsd = 0;
    streamChars = 0;
    metrics.streamTokensOut = 0;
    // Session totals and byModel persist across turns.
    clearPending();
    notifyNow();
  }

  function flush(): void {
    // A flush marks a settle point (turn end); any in-flight estimate is stale.
    streamChars = 0;
    metrics.streamTokensOut = 0;
    clearPending();
    notifyNow();
  }

  return { record, noteStreamChars, subscribe, snapshot, startTurn, flush };
}

// ── Event construction ────────────────────────────────────────────────────────

/**
 * Build a {@link MetricsEvent} from raw token usage, pricing it via the
 * existing rate card so callers never hand-roll cost math. `usage.cachedTokens`
 * (a subset of `inputTokens`) flows straight into the rate card's own cache
 * discount, so a call that hit the provider's prompt cache is priced — and
 * reported — correctly instead of as if every input token were billed fresh.
 */
export function metricsEventFor(
  callId: string,
  kind: "model_call" | "tool_call",
  model: string,
  usage: TokenUsage,
  at: number,
): MetricsEvent {
  return {
    callId,
    kind,
    model,
    tokensIn: usage.inputTokens ?? 0,
    tokensOut: usage.outputTokens ?? 0,
    cachedTokens: usage.cachedTokens ?? 0,
    costUsd: estimateCostUsd(model, usage),
    at,
  };
}
