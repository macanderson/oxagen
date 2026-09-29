// triage-state.ts: the work item state a triage decision sets.
//
// work.items.state has no duplicate or out_of_scope state. Both hold the item:
// a duplicate waits for a person to confirm or reject it and stays out of every
// batch until then, and an out of scope item waits for a person to close it
// (agent-work-spec.html, Duplicates and Work items). held_reason says which.
import type { TriageDecision } from "../types";

/** Why triage held an item. */
export const TRIAGE_HELD_REASONS = ["duplicate", "out_of_scope"] as const;
export type TriageHeldReason = (typeof TRIAGE_HELD_REASONS)[number];

/** The item columns a decision sets. duplicateOf is a work item id, not a row id. */
export interface TriageItemState {
  state: "triaged" | "needs_info" | "held";
  heldReason: TriageHeldReason | null;
  duplicateOf: TriageDecision["item"] | null;
}

/** The state, held reason, and duplicate a decision sets on its item. */
export function triageItemState(decision: Pick<TriageDecision, "state" | "duplicates">): TriageItemState {
  switch (decision.state) {
    case "triaged":
      return { state: "triaged", heldReason: null, duplicateOf: null };
    case "needs_info":
      return { state: "needs_info", heldReason: null, duplicateOf: null };
    case "out_of_scope":
      return { state: "held", heldReason: "out_of_scope", duplicateOf: null };
    case "duplicate":
      return { state: "held", heldReason: "duplicate", duplicateOf: decision.duplicates[0] ?? null };
  }
}
