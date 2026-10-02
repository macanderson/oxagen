// triage-output.ts: the checks a schema-valid triage decision still has to pass.
//
// triage/v1 fixes the shape. These checks tie the decision to its input: it
// names the item triage was asked about, it cites only numbered rules of the
// priorities record it read, and every duplicate or related item is open work
// it was shown. A decision that fails one is rejected like one that fails the
// schema.
import type { TriageDecision } from "../types";
import type { TriageOpenItem } from "./triage-item";

/** What a decision is checked against. */
export interface TriageOutputContext {
  item: TriageDecision["item"];
  /** Every cite the priorities record allows, from priorityCites. */
  cites: readonly string[];
  openWork: readonly Pick<TriageOpenItem, "id">[];
}

/** The problems with a schema-valid decision. Empty when it passes. */
export function checkTriageOutput(decision: TriageDecision, context: TriageOutputContext): string[] {
  const problems: string[] = [];
  if (decision.item !== context.item) {
    problems.push(`/item is ${decision.item}, but triage was asked about ${context.item}`);
  }
  const cites = new Set(context.cites);
  for (const cite of decision.priority.cites) {
    if (!cites.has(cite)) problems.push(`/priority/cites names ${cite}, which is not a rule of the priorities record`);
  }
  const open = new Set(context.openWork.map((item) => item.id));
  for (const field of ["duplicates", "related"] as const) {
    for (const id of decision[field]) {
      if (id === context.item) problems.push(`/${field} names the item itself`);
      else if (!open.has(id)) problems.push(`/${field} names ${id}, which is not in the open work`);
    }
  }
  return problems;
}
