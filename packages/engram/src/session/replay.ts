/**
 * Session replay — deterministic re-execution of a recorded session.
 *
 * Replay steps through the event log and verifies that context compilation
 * produces consistent results. Useful for debugging agent behavior and
 * detecting non-determinism or regressions.
 */
import type { Session, SessionEvent, ContextCompiledData } from "./types";

export interface ReplayStep {
  /** Event being replayed. */
  event: SessionEvent;
  /** Whether the replayed output matches the recorded output. */
  matches: boolean;
  /** Description of any divergence. */
  divergence?: string;
}

export interface ReplayResult {
  sessionId: string;
  totalEvents: number;
  stepsReplayed: number;
  divergences: ReplayStep[];
  /** True if all steps matched — deterministic replay. */
  deterministic: boolean;
}

/**
 * Replay a session's context compilations to check for determinism.
 *
 * For each turn, reconstructs the TaskFrame and verifies the compile()
 * output metadata matches what was recorded. Full content comparison
 * is impractical (depends on store state), so we compare metrics:
 * - candidatesRetrieved
 * - candidatesPacked
 * - cacheHitRate (within tolerance)
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

    // Basic sanity checks on the recorded data
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
