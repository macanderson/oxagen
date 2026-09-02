/**
 * Session replay analysis — inspects a recorded session's event log.
 *
 * Nothing here re-executes the session or re-runs `compile()`. These functions
 * read the events that were already written and report on them. Real replay —
 * re-compiling each turn against a live store and diffing the result — is not
 * implemented; see {@link analyzeReplay} for exactly what is checked today.
 */
import type { Session, SessionEvent, ContextCompiledData } from "./types";

export interface ReplayStep {
  /** The `context_compiled` event that failed its check. */
  event: SessionEvent;
  /** Always false — a step is only recorded here when it failed. */
  matches: boolean;
  /** Which recorded value was out of range. */
  divergence?: string;
}

export interface ReplayResult {
  sessionId: string;
  totalEvents: number;
  /** How many `context_compiled` events were inspected. */
  stepsReplayed: number;
  divergences: ReplayStep[];
  /**
   * True when every inspected event carried in-range compile metrics.
   *
   * This is a plausibility check on recorded data, NOT a proof that a re-run
   * would produce the same window — no re-compilation happens. Treat it as
   * "the trace is not obviously corrupt", and do not surface it to a user as
   * evidence that the agent's context is reproducible.
   */
  deterministic: boolean;
}

/**
 * Check a session's recorded compile metrics for obviously impossible values.
 *
 * For every `context_compiled` event, assert `totalTokens >= 0` and
 * `cacheHitRate` in [0, 1]. Anything out of range is reported as a divergence
 * and clears the `deterministic` flag. No TaskFrame is reconstructed and
 * `compile()` is never called — comparing against a fresh compile would
 * require the original store state, which the event log does not carry.
 */
export function analyzeReplay(session: Session): ReplayResult {
  const result: ReplayResult = {
    sessionId: session.id,
    totalEvents: session.events.length,
    stepsReplayed: 0,
    divergences: [],
    deterministic: true,
  };

  // Walk through turn pairs (turn_start → context_compiled)
  for (let i = 0; i < session.events.length; i++) {
    const event = session.events[i]!;
    if (event.type !== "context_compiled") continue;

    result.stepsReplayed++;
    const data = event.data as ContextCompiledData;

    // Range checks on the recorded data — a value outside these bounds means
    // the writer, not the agent, was wrong.
    if (
      data.totalTokens < 0 ||
      data.cacheHitRate < 0 ||
      data.cacheHitRate > 1
    ) {
      result.divergences.push({
        event,
        matches: false,
        divergence: `Invalid compile metrics: tokens=${data.totalTokens}, cacheHitRate=${data.cacheHitRate}`,
      });
      result.deterministic = false;
    }
  }

  return result;
}

/**
 * Extract turn-by-turn metrics from a session for comparison.
 */
export function extractTurnMetrics(session: Session): Array<{
  turnId: string;
  compileMs: number;
  tokens: number;
  cacheHitRate: number;
  toolCalls: number;
  outcome: string;
}> {
  const metrics: ReturnType<typeof extractTurnMetrics> = [];
  let currentTurnId: string | null = null;
  let compileMs = 0;
  let tokens = 0;
  let cacheHitRate = 0;
  let toolCalls = 0;
  let outcome = "unknown";

  for (const event of session.events) {
    switch (event.type) {
      case "turn_start":
        // Flush previous turn
        if (currentTurnId) {
          metrics.push({
            turnId: currentTurnId,
            compileMs,
            tokens,
            cacheHitRate,
            toolCalls,
            outcome,
          });
        }
        currentTurnId = event.turnId;
        compileMs = 0;
        tokens = 0;
        cacheHitRate = 0;
        toolCalls = 0;
        outcome = "unknown";
        break;
      case "context_compiled": {
        const d = event.data as ContextCompiledData;
        compileMs = d.compileMs;
        tokens = d.totalTokens;
        cacheHitRate = d.cacheHitRate;
        break;
      }
      case "tool_call":
        toolCalls++;
        break;
      case "turn_end": {
        const d = event.data as { outcome: string };
        outcome = d.outcome;
        break;
      }
    }
  }

  // Flush last turn
  if (currentTurnId) {
    metrics.push({
      turnId: currentTurnId,
      compileMs,
      tokens,
      cacheHitRate,
      toolCalls,
      outcome,
    });
  }

  return metrics;
}
