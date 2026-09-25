/**
 * A goal-shaped turn: the in-app agent works in rounds, and after each round
 * a verifier judges the transcript against a goal the caller stated (ADR-177;
 * the in-app agent spec, §6).
 *
 * The engine owns the loop. `goal` on `POST /v1/turns` makes the turn a goal
 * run (`stella-serve/src/routes.rs`, `GoalSpec`), and `drive_goal`
 * (`stella-serve/src/goal.rs`) runs a working round, asks the verifier, and
 * either ends the turn or sends the verifier's feedback back to the worker.
 * Two things reach the host that a plain turn never sends:
 *
 * - `provider_request` frames with `role: "verdict"`. They are the verifier's
 *   own model calls, and `modelForRole` answers them on a different tier from
 *   the worker's, because a judge that shares the worker's weights is not an
 *   independent judge.
 * - one `goal_verdict` event per round, with the verdict and its reasoning.
 *   This module turns that event into the receipt the run records.
 *
 * The host sends no `verifier_provider_id`. The engine would stamp it on the
 * verifier's frames so a host could route them, but this host routes by the
 * frame's `role`, which the engine sets on every verifier call either way.
 */
import type {
  AgentEvent,
  GoalSpec,
  GoalVerdictEvent,
} from "@oxagen/stella-engine-client";
import { digestJcs } from "@oxagen/run-evidence";

/** The event type a round's verdict is recorded as. */
export const GOAL_VERDICT_EVENT_TYPE = "verification.goal_verdict";

/** The goal a caller put on a turn, as `ask_assistant` validated it. */
export interface GovernedTurnGoal {
  /** The condition the result must meet, stated so a verifier can check it. */
  statement: string;
  /** Working rounds before the engine gives up. */
  maxRounds: number;
}

/** One verifier round, as the ledger records it. */
export interface TurnLedgerGoalVerdict {
  /** The `event` frame's seq. */
  seq: number;
  /** 1-based round number. */
  round: number;
  met: boolean;
  /** The verifier's reasoning; the frame's body, never its payload. */
  reasoning: string;
  /** The goal the round was judged against. */
  goal: string;
  /** What the verifier's calls cost this round, in dollars. */
  costUsd: number;
}

/** The goal as the engine's `GoalSpec` takes it. */
export function toGoalSpec(goal: GovernedTurnGoal): GoalSpec {
  return { goal: goal.statement, max_rounds: goal.maxRounds };
}

function isGoalVerdict(event: AgentEvent): event is GoalVerdictEvent {
  return event.type === "goal_verdict";
}

/**
 * The receipt for a `goal_verdict` event, or null for any other event. The
 * goal comes from the turn, not the event, because the engine's event names
 * the round and the verdict and leaves the goal to the host that set it.
 */
export function goalVerdictOf(
  event: AgentEvent,
  seq: number,
  goal: GovernedTurnGoal,
): TurnLedgerGoalVerdict | null {
  if (!isGoalVerdict(event)) return null;
  return {
    seq,
    round: event.round,
    met: event.met,
    reasoning: event.reasoning,
    goal: goal.statement,
    costUsd: event.cost_usd,
  };
}

/**
 * The inline payload of a `verification.goal_verdict` frame: identifiers,
 * digests and counts, never text. The goal and the reasoning are the frame's
 * body. The cost is integer micro-dollars because `canonicalJson` refuses a
 * float, and a negative or non-finite cost reads as zero rather than failing
 * the turn over a figure the engine computed.
 */
export function goalVerdictPayload(record: TurnLedgerGoalVerdict): {
  engine_seq: number;
  round: number;
  met: boolean;
  goal_digest: string;
  reasoning_digest: string;
  verifier_cost_usd_micros: number;
} {
  const micros = Math.round(record.costUsd * 1_000_000);
  return {
    engine_seq: record.seq,
    round: record.round,
    met: record.met,
    goal_digest: digestJcs(record.goal),
    reasoning_digest: digestJcs(record.reasoning),
    verifier_cost_usd_micros: Number.isFinite(micros) ? Math.max(0, micros) : 0,
  };
}
