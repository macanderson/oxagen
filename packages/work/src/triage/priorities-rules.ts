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

/** One numbered rule and its text. */
export interface PriorityRule {
  number: number;
  /** The rule's text, with its continuation lines joined by spaces. */
  text: string;
}

/**
 * The body's numbered rules, in ascending order. A rule's text runs from its
 * number to the next rule or the end, with its continuation lines joined. A
 * number that repeats keeps its first text.
 */
export function priorityRules(body: string): PriorityRule[] {
  const rules = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const match = /^(\d+)\.\s+(\S.*)$/.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (rules.has(number)) {
        current = null;
        continue;
      }
      current = [match[2]!.trim()];
      rules.set(number, current);
      continue;
    }
    if (current !== null && line.trim() !== "") current.push(line.trim());
    else if (line.trim() === "") current = null;
  }
  return [...rules.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, lines]) => ({ number, text: lines.join(" ") }));
}
