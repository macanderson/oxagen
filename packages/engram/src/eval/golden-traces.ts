/**
 * Golden traces — recorded task sequences used as regression baselines.
 *
 * A golden trace captures: what the agent was asked, what context it received,
 * what tools it called, and what the outcome was. The eval harness replays
 * these and verifies context quality hasn't degraded.
 */
import type { TaskFrame } from "../retrieval/types";
import type { TokenBudget } from "../compiler/packer";
import type { EvalMetrics } from "./metrics";

export interface GoldenTrace {
  id: string;
  name: string;
  description: string;
  /** The sequence of turns that constitute the task. */
  turns: GoldenTurn[];
  /** Record IDs that SHOULD be retrieved for this task. */
  expectedRecords: string[];
  /** Record IDs that should NOT be in context (noise). */
  excludedRecords: string[];
  /** Baseline metrics from the best known run. */
  baseline: EvalMetrics;
  /** When this trace was last validated. */
  lastValidated: string;
}

export interface GoldenTurn {
  /** Task frame for this turn. */
  taskFrame: TaskFrame;
  /** Budget for this turn. */
  budget: TokenBudget;
  /** Records that MUST be in the context window for this turn. */
  requiredInContext: string[];
  /** Records that must NOT be in context (would be harmful). */
  forbiddenInContext: string[];
  /** Expected tool calls and their results. */
  expectedToolCalls: Array<{ tool: string; inputPattern?: string }>;
  /** Expected outcome. */
  expectedOutcome: "success" | "failure";
}

/**
 * Validate a compiled context window against a golden turn's expectations.
 */
export function validateTurn(
  packedRecordIds: string[],
  turn: GoldenTurn,
): TurnValidation {
  const packed = new Set(packedRecordIds);

  const missingRequired = turn.requiredInContext.filter(
    (id) => !packed.has(id),
  );
  const includedForbidden = turn.forbiddenInContext.filter((id) =>
    packed.has(id),
  );

  const precision =
    turn.requiredInContext.length > 0
      ? (turn.requiredInContext.length - missingRequired.length) /
        turn.requiredInContext.length
      : 1.0;

  return {
    pass: missingRequired.length === 0 && includedForbidden.length === 0,
    precision,
    missingRequired,
    includedForbidden,
  };
}

export interface TurnValidation {
  pass: boolean;
  /**
   * Fraction of `requiredInContext` that was actually packed (1.0 when the
   * turn requires nothing). Despite the name — and despite being averaged into
   * `EvalMetrics.contextPrecision` — this is a RECALL measure: it says nothing
   * about how much of the packed window was relevant.
   */
  precision: number;
  missingRequired: string[];
  includedForbidden: string[];
}
