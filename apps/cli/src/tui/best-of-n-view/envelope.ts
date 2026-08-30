/**
 * The machine-readable result envelope that terminates `oxagen solve --json`'s
 * JSONL stream. The bench adapter (`_populate_best_of_n_metadata` in
 * `bench/terminal-bench/src/oxagen_terminal_bench/oxagen_agent.py`) parses the
 * final `type: "result"` line for race outcome AND — via the optional `usage`
 * block — cost/token/step/wall totals. Kept in its own ink-free module so the
 * contract is unit-testable without rendering anything.
 */
import type { BestOfNResult } from "../../agent/best-of-n.js";
import type { SolveUsageSummary } from "../../agent/solve-usage.js";

export function resultEnvelope(
  result: BestOfNResult,
  usage?: SolveUsageSummary,
): Record<string, unknown> {
  return {
    type: "result",
    winnerId: result.selection.winnerId,
    reasoning: result.selection.reasoning,
    ranking: result.selection.ranking,
    winnerFiles: result.winner?.changedFiles ?? [],
    candidates: result.candidates.map((c) => ({
      id: c.id,
      model: c.model,
      changedFiles: c.changedFiles,
      steps: c.steps,
      failed: c.failed ?? false,
    })),
    // Aggregated token/cost metering across every model call the race made
    // (candidate turns + pipeline judges + the comparative selector). Only
    // present when the caller wired a usage accumulator (solve.ts does).
    ...(usage ? { usage } : {}),
  };
}
