/**
 * Live metrics contract (pipeline Group 8 bug 2 — not yet built).
 *
 * Live token and cost metrics for the status line. Every model call and tool
 * call emits a `MetricsEvent`; `SessionMetrics` accumulates them, and the
 * status line subscribes and re-renders in real time.
 *
 * Fresh, standalone stub — Group 8 has not landed in this worktree. Matches the
 * original `contracts/metrics.ts` stub as-is (no shipped code to reconcile
 * against yet).
 */
export interface MetricsEvent {
  callId: string;
  kind: "model_call" | "tool_call";
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number; // cost for THIS call, from the price table
  at: number; // epoch ms
}

export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface SessionMetrics {
  turnTokensIn: number;
  turnTokensOut: number;
  turnCostUsd: number;
  sessionTokensIn: number;
  sessionTokensOut: number;
  sessionCostUsd: number;
  byModel: Record<string, ModelUsage>;
}

export interface PriceRow {
  model: string;
  inputUsdPerMTok: number; // price per 1M input tokens; on-device is 0
  outputUsdPerMTok: number;
}

export interface MetricsBus {
  // Called on every model call and tool call. Updates SessionMetrics.
  record(ev: MetricsEvent): void;
  // Status line subscribes here and re-renders (throttled) on each event.
  subscribe(handler: (m: SessionMetrics) => void): () => void;
  snapshot(): SessionMetrics;
  // Resets turn totals at the start of a turn; keeps session totals.
  startTurn(): void;
  // Forces a final render so totals settle after the turn.
  flush(): void;
}
