// report.ts: how each check hands lint a finding, and the wording the
// messages share.
import type { Finding, LintRule } from "./index";

/**
 * Records one finding. lint adds the rule's level and drops a rule that does
 * not run on the server's source type, so a check never tests the type itself.
 */
export type Report = (rule: LintRule, at: Omit<Finding, "rule" | "level">) => void;

function joinList(items: readonly string[], word: "and" | "or"): string {
  if (items.length <= 2) return items.join(` ${word} `);
  const last = items.at(-1) ?? "";
  return `${items.slice(0, -1).join(", ")}, ${word} ${last}`;
}

/** "a", "a or b", or "a, b, or c". */
export function orList(items: readonly string[]): string {
  return joinList(items, "or");
}

/** "a", "a and b", or "a, b, and c". */
export function andList(items: readonly string[]): string {
  return joinList(items, "and");
}

/** A count as a person reads it: 8,000. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}
