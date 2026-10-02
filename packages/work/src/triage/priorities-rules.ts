// priorities-rules.ts: the numbered rules of a priorities record, and the cites
// a triage decision may use.
//
// The record's body opens with one instruction line, then numbers its rules
// `1.`, `2.`, and so on, each at the start of a line. A rule may run onto
// indented lines. A decision cites a rule as `<lineage>#<number>`, such as
// `aintel.work.priorities#2` (agent-work-spec.html, Priorities).
import type { TriagePriorities } from "./triage-item";

/** A numbered rule opens a line: digits, a period, a space, then text. */
const RULE_LINE = /^(\d+)\.\s+\S/gm;

/** The rule numbers the body declares, in ascending order, each once. */
export function priorityRuleNumbers(body: string): number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(RULE_LINE)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Every cite a decision may use against this record, such as `aintel.work.priorities#2`. */
export function priorityCites(priorities: Pick<TriagePriorities, "lineage" | "body">): string[] {
  return priorityRuleNumbers(priorities.body).map((n) => `${priorities.lineage}#${n}`);
}
