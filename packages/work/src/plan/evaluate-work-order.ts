// evaluate-work-order.ts: a work order's state, derived from stored facts.
//
// evaluateWorkOrder is pure, as ADR-162 derives a dispatch's state. A late WAL,
// or a webhook that beats the frame it follows, still reads the right state
// once both facts are stored. work-in-flight-spec.md §8.8 sets the states:
//
// | State          | Entered when                                                          |
// | queued         | In a sent plan, waiting for a predecessor, a free slot, or budget.    |
// | sent           | It reached a runtime, and no run has claimed it.                      |
// | in_progress    | A run claimed it and sealed a frame after the send.                   |
// | pr_opened      | A bound run's chain carries an oxagen:pr_link frame.                  |
// | waiting_on_you | Every item is claimed.                                                |
// | accepted       | A person accepted the work. Terminal.                                 |
// | stopped        | A person stopped the work order. Terminal.                            |
//
// Collisions, parked threads, and stale claims are flags beside the state, not
// states of their own. A claim reads stale after CLAIM_STALE_MINUTES with no frame.
import { notBuilt } from "../not-built";
import type { Claim } from "./plan-work-orders";

/** The states of a work order. accepted and stopped are terminal. */
export const WORK_ORDER_STATES = [
  "queued",
  "sent",
  "in_progress",
  "pr_opened",
  "waiting_on_you",
  "accepted",
  "stopped",
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

/** A claim with no frame from its run for this many minutes reads stale. */
export const CLAIM_STALE_MINUTES = 60;

/** An edit inside another live work order's exclusive claim. */
export interface WorkOrderCollision {
  path: string;
  otherWorkOrder: string;
}

/** One claim and when its lease last renewed. */
export interface WorkOrderLease {
  claim: Claim;
  /** RFC 3339: the last frame the run's host shipped. */
  renewedAt: string;
}

/** The stored facts evaluateWorkOrder reads. Every time is RFC 3339. */
export interface WorkOrderFacts {
  /** When it reached a runtime, or null while it is queued. */
  sentAt: string | null;
  /** The run that claimed it and the seal time of that run's latest frame, or null before a claim. */
  claim: { runId: string; lastFrameSealedAt: string | null } | null;
  /** True when a bound run's chain carries an oxagen:pr_link frame. */
  prLinked: boolean;
  /** The number of items in the work order, and how many an agent has claimed. */
  items: number;
  itemsClaimed: number;
  acceptedAt: string | null;
  stoppedAt: string | null;
  collisions: readonly WorkOrderCollision[];
  /** Message threads parked for a person. */
  parkedThreads: number;
  leases: readonly WorkOrderLease[];
  /** The time to evaluate at. Passed in so the function stays pure. */
  now: string;
}

/** Conditions beside the state that wait on a person. */
export interface WorkOrderFlags {
  collisions: WorkOrderCollision[];
  parkedThreads: number;
  staleClaims: Claim[];
}

/** The output of evaluateWorkOrder. */
export interface WorkOrderEvaluation {
  state: WorkOrderState;
  flags: WorkOrderFlags;
}

/** Derive a work order's state and flags from its facts. Pure. */
export function evaluateWorkOrder(facts: WorkOrderFacts): WorkOrderEvaluation {
  return notBuilt("evaluateWorkOrder", facts);
}
