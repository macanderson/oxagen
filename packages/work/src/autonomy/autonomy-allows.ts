// autonomy-allows.ts: whether a scope's autonomy level allows one action now.
//
// Oxagen generates Cedar policies from the [[autonomy]] entries of work.toml,
// one per action, and autonomyAllows evaluates them at the moment Oxagen would
// act, not when the file merged, so a level lowered a minute ago applies to the
// next send. agent-work-spec.html (Autonomy levels) sets what each level allows:
//
// | Level | Name         | Oxagen also                                                          |
// | 0     | Suggest      | Triages, drafts the done record, and plans batches. Nothing more.    |
// | 1     | Send         | Sends placed work orders as the scope's operator (work.send).        |
// | 2     | Merge proven | Merges a proven record whose risk is low or medium (work.merge).     |
// | 3     | Autonomous   | Locks a drafted record that passes lint (work.lock), and closes the  |
// |       |              | source item where the collector's close switch is on (work.close).   |
//
// Level 2 and level 3 never merge high-risk work. The level in force is the lower
// of the file's level and the latest automatic lowering (work.autonomy_events).
//
// Every way the question cannot be answered is a deny with the reason in
// `errors`: facts out of range, a scope with no operator, an evaluator that is
// not loaded, or a Cedar error. autonomyAllows never throws, and it never allows
// what it could not evaluate.
import { DONE_VERDICTS, type DoneVerdict } from "@oxagen/done-record";
import { type CedarRuntime, loadCedarRuntime } from "@oxagen/policy";
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type AutonomyScope,
  RISK_LEVELS,
  type RiskLevel,
  WORK_ACTIONS,
  type WorkAction,
} from "../types";
import { AUTONOMY_ACTION_TYPE, AUTONOMY_CEDAR_SCHEMA, AUTONOMY_PRINCIPAL_TYPE, AUTONOMY_RESOURCE_TYPE } from "./cedar-schema";
import { AUTONOMY_FORBIDS, policiesForScope } from "./policy";
import { parseAutonomyScope, scopeKey } from "./scope";

export * from "./cedar-schema";
export * from "./policy";
export * from "./risk";
export * from "./scope";

/** What autonomyAllows reads about the work order at the moment Oxagen would act. */
export interface AutonomyFacts {
  /** The scope's operator, whom Oxagen acts as. */
  operator: string;
  /** The level in force: the lower of work.toml's level and the latest automatic lowering. */
  level: AutonomyLevel;
  /** The done record's verdict now. */
  verdict: DoneVerdict;
  /** The pull request's risk. Null before a pull request exists. */
  risk: RiskLevel | null;
  /** True when the drafted done record passes lint. Read for work.lock. */
  lintPassed: boolean;
  /** True when the source item's collector has its close switch on. Read for work.close. */
  closeSwitch: boolean;
  /** What Oxagen spent in the scope today, and the scope's max_daily_usd, when it sets one. */
  spentTodayUsd: number;
  maxDailyUsd?: number;
}

/** Cedar's answer, in the shape @oxagen/recorder's CedarVerdict uses. */
export interface AutonomyDecision {
  decision: "allow" | "deny";
  /** The ids of the policies that decided, sorted. Empty for a deny no policy permitted. */
  reasons: string[];
  /** Why the request could not be decided. A decision with errors is always a deny. */
  errors: string[];
}

/** The resource id every request uses. The work order's facts are its attributes. */
const WORK_ORDER_ID = "work-order";

let evaluator: CedarRuntime | null = null;

/**
 * Load Cedar's evaluator for autonomyAllows. Call it once when the process
 * starts, before the first autonomyAllows. Until it resolves true, every
 * autonomyAllows denies with an error. Returns false when this host has no
 * evaluator, so the caller can refuse to start an autonomous loop.
 */
export async function loadAutonomyRuntime(
  load: () => Promise<CedarRuntime | null> = loadCedarRuntime,
): Promise<boolean> {
  evaluator = await load();
  return evaluator !== null;
}

function deny(errors: string[], reasons: string[] = []): AutonomyDecision {
  return { decision: "deny", reasons, errors };
}

/** Each fact that is out of range, as a sentence. Empty when every fact is usable. */
function factErrors(action: unknown, facts: AutonomyFacts): string[] {
  const errors: string[] = [];
  if (!(WORK_ACTIONS as readonly unknown[]).includes(action)) {
    errors.push(`The action must be one of ${WORK_ACTIONS.join(", ")}.`);
  }
  if (typeof facts.operator !== "string" || facts.operator.trim().length === 0) {
    errors.push("The scope has no operator. Oxagen acts only as a scope's operator.");
  }
  if (!(AUTONOMY_LEVELS as readonly unknown[]).includes(facts.level)) errors.push("The level must be 0, 1, 2, or 3.");
  if (!(DONE_VERDICTS as readonly unknown[]).includes(facts.verdict)) {
    errors.push(`The verdict must be one of ${DONE_VERDICTS.join(", ")}.`);
  }
  if (facts.risk !== null && !(RISK_LEVELS as readonly unknown[]).includes(facts.risk)) {
    errors.push("The risk must be low, medium, high, or null.");
  }
  if (typeof facts.lintPassed !== "boolean") errors.push("lintPassed must be true or false.");
  if (typeof facts.closeSwitch !== "boolean") errors.push("closeSwitch must be true or false.");
  const cents = Math.round(facts.spentTodayUsd * 100);
  if (!Number.isFinite(facts.spentTodayUsd) || facts.spentTodayUsd < 0 || !Number.isSafeInteger(cents)) {
    errors.push("spentTodayUsd must be a number of dollars, 0 or more.");
  }
  return errors;
}

/**
 * Evaluate one request against a set of autonomy policies. autonomyAllows
 * passes one scope's policies. A test or a steering check can pass the whole
 * generated file, to show that one scope's permits never answer for another.
 */
export function evaluateAutonomy(
  runtime: CedarRuntime,
  policies: Readonly<Record<string, string>>,
  scope: AutonomyScope,
  action: WorkAction,
  facts: AutonomyFacts,
): AutonomyDecision {
  const parsed = parseAutonomyScope(scope);
  const errors = factErrors(action, facts);
  if (parsed === null) errors.unshift("The scope must be { label } or { repo, paths } with at least one path.");
  if (parsed === null || errors.length > 0) return deny(errors);

  const attrs: Record<string, string | number | boolean> = {
    scope: scopeKey(parsed),
    level: facts.level,
    verdict: facts.verdict,
    lint_passed: facts.lintPassed,
    close_switch: facts.closeSwitch,
    spent_today_cents: Math.round(facts.spentTodayUsd * 100),
  };
  if (facts.risk !== null) attrs.risk = facts.risk;
  let answer: ReturnType<CedarRuntime["isAuthorized"]>;
  try {
    answer = runtime.isAuthorized({
      principal: { type: AUTONOMY_PRINCIPAL_TYPE, id: facts.operator },
      action: { type: AUTONOMY_ACTION_TYPE, id: action },
      resource: { type: AUTONOMY_RESOURCE_TYPE, id: WORK_ORDER_ID },
      context: {},
      schema: AUTONOMY_CEDAR_SCHEMA,
      validateRequest: true,
      policies: { staticPolicies: { ...policies } },
      entities: [
        { uid: { type: AUTONOMY_PRINCIPAL_TYPE, id: facts.operator }, attrs: {}, parents: [] },
        { uid: { type: AUTONOMY_RESOURCE_TYPE, id: WORK_ORDER_ID }, attrs, parents: [] },
      ],
    });
  } catch (error) {
    return deny([`Cedar could not evaluate the request: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (answer.type === "failure") return deny(answer.errors.map((e) => e.message));
  const { decision, diagnostics } = answer.response;
  const reasons = [...diagnostics.reason].sort();
  if (diagnostics.errors.length > 0) {
    return deny(
      diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`),
      reasons,
    );
  }
  return decision === "allow" ? { decision: "allow", reasons, errors: [] } : deny([], reasons);
}

/** Decide whether the scope's level allows the action now. */
export function autonomyAllows(scope: AutonomyScope, action: WorkAction, facts: AutonomyFacts): AutonomyDecision {
  if (evaluator === null) {
    return deny(["Cedar's evaluator is not loaded. Call loadAutonomyRuntime() when the process starts."]);
  }
  const scoped = policiesForScope(scope, facts.operator, facts.maxDailyUsd);
  if (scoped.errors.length > 0) return deny(scoped.errors);
  return evaluateAutonomy(evaluator, { ...scoped.policies, ...AUTONOMY_FORBIDS }, scope, action, facts);
}
