/**
 * The evaluator — pure, synchronous, deterministic. No I/O, no clock, no
 * randomness: the same rule set and subject always produce the same verdict,
 * which is what lets an audit row that records both re-derive the decision
 * byte-for-byte.
 */
import type {
  Condition,
  ConditionLeaf,
  DecisionRule,
  DecisionSubject,
  RuleSet,
  Verdict,
} from "./types";

/**
 * Judge one capability call against a rule set.
 *
 * Returns the FIRST matching rule's verdict in (priority desc, id asc) order,
 * or `null` when no rule matches — null means "this rule set has no opinion",
 * and the caller falls through to whatever the surface did before rules
 * existed. First-match rather than most-severe because policy needs carve-outs
 * ("deny refunds over $500" above "allow refunds for the support role" cannot
 * compose any other way), and the total order makes the winner reviewable.
 */
export function evaluateRules(
  ruleSet: RuleSet,
  subject: DecisionSubject,
): Verdict | null {
  for (const rule of orderedRules(ruleSet.rules)) {
    if (!capabilityMatches(rule.capability, subject.capability)) continue;
    if (rule.when !== undefined && !evaluateCondition(rule.when, subject)) {
      continue;
    }
    return {
      effect: rule.effect,
      ruleId: rule.id,
      description: rule.description,
    };
  }
  return null;
}

/** The union of `requires_facts` across the rules that could govern `capability`. */
export function requiredFactKeys(
  ruleSet: RuleSet,
  capability: string,
): string[] {
  const keys = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (!capabilityMatches(rule.capability, capability)) continue;
    for (const key of rule.requires_facts ?? []) keys.add(key);
  }
  return [...keys].sort();
}

/** Priority desc, then id bytewise asc — a total order, so ties cannot flap. */
function orderedRules(rules: readonly DecisionRule[]): DecisionRule[] {
  return [...rules].sort((a, b) => {
    const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Exact name, or a `*`-suffix prefix pattern (`refund_*`); bare `*` is every capability. */
export function capabilityMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export function evaluateCondition(
  condition: Condition,
  subject: DecisionSubject,
): boolean {
  if ("all" in condition) {
    return condition.all.every((c) => evaluateCondition(c, subject));
  }
  if ("any" in condition) {
    return condition.any.some((c) => evaluateCondition(c, subject));
  }
  if ("not" in condition) {
    return !evaluateCondition(condition.not, subject);
  }
  return evaluateLeaf(condition, subject);
}

function evaluateLeaf(leaf: ConditionLeaf, subject: DecisionSubject): boolean {
  const resolved = resolveFact(leaf.fact, subject);
  if (leaf.op === "exists") {
    return resolved.found && resolved.value !== undefined;
  }
  // Every other operator needs a value on both sides. A missing fact matches
  // nothing rather than erroring: a rule over a fact this call cannot supply
  // is simply not about this call.
  if (!resolved.found) return false;
  const actual = resolved.value;

  switch (leaf.op) {
    case "eq":
      return actual === leaf.value;
    case "neq":
      return actual !== leaf.value;
    case "lt":
      return (
        bothNumbers(actual, leaf.value) &&
        (actual as number) < (leaf.value as number)
      );
    case "lte":
      return (
        bothNumbers(actual, leaf.value) &&
        (actual as number) <= (leaf.value as number)
      );
    case "gt":
      return (
        bothNumbers(actual, leaf.value) &&
        (actual as number) > (leaf.value as number)
      );
    case "gte":
      return (
        bothNumbers(actual, leaf.value) &&
        (actual as number) >= (leaf.value as number)
      );
    case "in":
      return Array.isArray(leaf.value) && leaf.value.includes(actual);
    case "not_in":
      return Array.isArray(leaf.value) && !leaf.value.includes(actual);
    case "contains":
      if (typeof actual === "string" && typeof leaf.value === "string") {
        return actual.includes(leaf.value);
      }
      return Array.isArray(actual) && actual.includes(leaf.value);
    case "starts_with":
      return (
        typeof actual === "string" &&
        typeof leaf.value === "string" &&
        actual.startsWith(leaf.value)
      );
  }
}

/**
 * Numeric comparisons are numbers-only by design. Coercing "50" to 50 would
 * make a rule's behaviour depend on which serializer touched the payload
 * last; a policy that needs a number gets one or does not match.
 */
function bothNumbers(a: unknown, b: unknown): boolean {
  return (
    typeof a === "number" &&
    Number.isFinite(a) &&
    typeof b === "number" &&
    Number.isFinite(b)
  );
}

/**
 * Walk a dot path from one of the three roots. Returns found:false for an
 * unknown root, a traversal through a non-object, or an absent key — the
 * distinction from `undefined`-valued leaves is what `exists` reports on.
 * Prototype-pollution-shaped segments never resolve: only own, enumerable
 * properties count.
 */
function resolveFact(
  path: string,
  subject: DecisionSubject,
): { found: boolean; value?: unknown } {
  const segments = path.split(".");
  const root = segments.shift();
  let cursor: unknown;
  if (root === "input") cursor = subject.input;
  else if (root === "facts") cursor = subject.facts;
  else if (root === "call") cursor = subject.call ?? {};
  else return { found: false };

  for (const segment of segments) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !Object.prototype.hasOwnProperty.call(cursor, segment)
    ) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}
