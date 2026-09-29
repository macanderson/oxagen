// policy.ts: policy/work-autonomy.cedar, written from the [[autonomy]] entries of work.toml.
//
// agent-work-spec.html (Policy): each step a level allows is a Cedar action,
// and Oxagen generates the policies from work.toml, so a person edits a level
// and never writes Cedar for it. One generator serves both readers. The steering
// repo gets the whole file, and autonomyAllows evaluates one scope's policies
// from the same function, so the file a reviewer reads is the policy that runs.
//
// The text does not depend on the level. Each permit tests `resource.level`,
// which autonomyAllows sets to the level in force when Oxagen acts, so a
// lowering applies before the steering PR that writes it merges.
import { cedarString } from "@oxagen/policy";
import { AUTONOMY_LEVELS, type AutonomyEntry, type AutonomyScope, type WorkAction, type WorkFile } from "../types";
import { AUTONOMY_ACTION_TYPE, AUTONOMY_MIN_LEVEL, AUTONOMY_PRINCIPAL_TYPE, AUTONOMY_RESOURCE_TYPE } from "./cedar-schema";
import { parseAutonomyScope, scopeKey } from "./scope";

/** Where the generated file lives in the steering repo. */
export const AUTONOMY_POLICY_PATH = "policy/work-autonomy.cedar" as const;

/** The id of the forbid that keeps high-risk work from merging at any level. */
export const HIGH_RISK_FORBID_ID = "work.merge/high-risk" as const;

/** The id of the forbid that keeps work with no known risk from merging. */
export const RISK_UNKNOWN_FORBID_ID = "work.merge/risk-unknown" as const;

const MERGE = `${AUTONOMY_ACTION_TYPE}::${cedarString("work.merge")}`;

/**
 * The forbids every scope shares. Level 2 and level 3 never merge high-risk
 * work, and a pull request whose risk is not known yet does not merge either.
 * A forbid beats every permit, so a hand edit to a permit cannot undo them.
 */
export const AUTONOMY_FORBIDS: Readonly<Record<string, string>> = {
  [HIGH_RISK_FORBID_ID]: `@id(${cedarString(HIGH_RISK_FORBID_ID)})
forbid (
  principal,
  action == ${MERGE},
  resource is ${AUTONOMY_RESOURCE_TYPE}
)
when { resource has risk && resource.risk == "high" };`,
  [RISK_UNKNOWN_FORBID_ID]: `@id(${cedarString(RISK_UNKNOWN_FORBID_ID)})
forbid (
  principal,
  action == ${MERGE},
  resource is ${AUTONOMY_RESOURCE_TYPE}
)
when { !(resource has risk) };`,
};

/** One scope's permits, or why they cannot be written. */
export interface ScopePolicies {
  /** The permits by policy id, one per action. Empty when `errors` is not. */
  policies: Record<string, string>;
  errors: string[];
}

/** The generated file, or why it cannot be written. */
export interface GeneratedAutonomyPolicy {
  path: typeof AUTONOMY_POLICY_PATH;
  /** The file's text. Null when `errors` is not empty, so no partial file is written. */
  text: string | null;
  /** Every policy in the file by id, forbids included. Empty when `errors` is not. */
  policies: Record<string, string>;
  errors: string[];
}

/** The id of one scope's permit for one action. */
export function permitId(action: WorkAction, scope: AutonomyScope): string {
  return `${action}/${scopeKey(scope)}`;
}

/** The whole dollars as cents, or null when the amount is not a positive number Cedar's Long can hold. */
function budgetCents(maxDailyUsd: number): number | null {
  if (!Number.isFinite(maxDailyUsd) || maxDailyUsd <= 0) return null;
  const cents = Math.round(maxDailyUsd * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** The conditions each action adds after the scope and level tests. */
function actionConditions(action: WorkAction, budget: number | null): string[] {
  switch (action) {
    case "work.send":
      return budget === null ? [] : [`resource.spent_today_cents < ${budget}`];
    case "work.merge":
      return ['resource.verdict == "proven"', "resource has risk", 'resource.risk != "high"'];
    case "work.lock":
      return ["resource.lint_passed"];
    case "work.close":
      return ["resource.close_switch"];
  }
}

function permitText(action: WorkAction, scope: AutonomyScope, operator: string, budget: number | null): string {
  const conditions = [
    `resource.scope == ${cedarString(scopeKey(scope))}`,
    `resource.level >= ${AUTONOMY_MIN_LEVEL[action]}`,
    ...actionConditions(action, budget),
  ];
  return `@id(${cedarString(permitId(action, scope))})
permit (
  principal == ${AUTONOMY_PRINCIPAL_TYPE}::${cedarString(operator)},
  action == ${AUTONOMY_ACTION_TYPE}::${cedarString(action)},
  resource is ${AUTONOMY_RESOURCE_TYPE}
)
when {
  ${conditions.join(" &&\n  ")}
};`;
}

const ACTIONS_IN_FILE_ORDER: readonly WorkAction[] = ["work.send", "work.merge", "work.lock", "work.close"];

/**
 * One scope's four permits. Each names the scope's operator as the only
 * principal, so every scope keeps an operator at every level, and Oxagen acts
 * as that person and never as itself. `maxDailyUsd` caps work.send.
 */
export function policiesForScope(scope: unknown, operator: unknown, maxDailyUsd?: unknown): ScopePolicies {
  const errors: string[] = [];
  const parsed = parseAutonomyScope(scope);
  if (parsed === null) {
    errors.push("The scope must be { label } or { repo, paths } with at least one path, and no value may be empty.");
  }
  const name = typeof operator === "string" ? operator : "";
  if (name.trim().length === 0) errors.push("Every scope needs an operator. Oxagen acts as that person at every level.");
  let budget: number | null = null;
  if (maxDailyUsd !== undefined) {
    budget = typeof maxDailyUsd === "number" ? budgetCents(maxDailyUsd) : null;
    if (budget === null) errors.push("max_daily_usd must be a number of dollars above 0.");
  }
  if (parsed === null || errors.length > 0) return { policies: {}, errors };
  const policies: Record<string, string> = {};
  for (const action of ACTIONS_IN_FILE_ORDER) {
    policies[permitId(action, parsed)] = permitText(action, parsed, name, budget);
  }
  return { policies, errors };
}

/**
 * Text from work.toml as it may appear in a comment: quoted, with every
 * character outside printable ASCII escaped. A label is outside text, and a
 * newline in one must not end the comment and start a policy.
 */
export function commentSafe(text: string): string {
  return cedarString(text).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${Number(c.codePointAt(0)).toString(16)}}`);
}

function describeEntry(entry: AutonomyEntry, index: number): string {
  const scope = parseAutonomyScope(entry.scope);
  return scope === null ? `[[autonomy]] entry ${index + 1}` : `[[autonomy]] entry ${index + 1} (${commentSafe(scopeKey(scope))})`;
}

const HEADER = `// Written by Oxagen from the [[autonomy]] entries of work/work.toml. Do not
// edit this file. Change a level in work.toml, and the steering PR rewrites it.
//
// The level is not in these policies. Each permit reads resource.level, which
// Oxagen sets when it acts: the lower of work.toml's level and the latest
// automatic lowering in work.autonomy_events. A lowering applies at once.
//
// Every permit names the scope's operator as its principal. Oxagen acts as
// that person, and a scope without one gets no permit.`;

/**
 * Generate policy/work-autonomy.cedar from work.toml. Any error in any entry
 * stops the whole file, because a file that silently dropped a scope would
 * read as that scope at level 0 with nobody told why.
 */
export function generateAutonomyPolicy(work: Pick<WorkFile, "autonomy">): GeneratedAutonomyPolicy {
  const errors: string[] = [];
  const policies: Record<string, string> = { ...AUTONOMY_FORBIDS };
  const sections: string[] = [
    HEADER,
    `// Level 2 and level 3 never merge high-risk work, and work whose risk is not\n// known yet does not merge.\n${Object.values(AUTONOMY_FORBIDS).join("\n\n")}`,
  ];
  const seen = new Map<string, number>();
  (work.autonomy ?? []).forEach((entry, index) => {
    const where = describeEntry(entry, index);
    const levelOk = (AUTONOMY_LEVELS as readonly unknown[]).includes(entry.level);
    if (!levelOk) errors.push(`${where}: level must be 0, 1, 2, or 3.`);
    const scoped = policiesForScope(entry.scope, entry.operator, entry.max_daily_usd);
    for (const error of scoped.errors) errors.push(`${where}: ${error}`);
    if (!levelOk || scoped.errors.length > 0) return;
    const key = scopeKey(entry.scope);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push(`${where}: entry ${first + 1} already sets this scope. Give each scope one entry.`);
      return;
    }
    seen.set(key, index);
    Object.assign(policies, scoped.policies);
    sections.push(
      `// Scope ${commentSafe(key)}. work.toml sets level ${entry.level}. Operator ${commentSafe(entry.operator)}.\n${Object.values(scoped.policies).join("\n\n")}`,
    );
  });
  if (errors.length > 0) return { path: AUTONOMY_POLICY_PATH, text: null, policies: {}, errors };
  return { path: AUTONOMY_POLICY_PATH, text: `${sections.join("\n\n")}\n`, policies, errors };
}
