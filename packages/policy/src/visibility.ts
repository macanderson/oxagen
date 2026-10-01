/**
 * Whether an agent can see a tool before it calls one (lane S12).
 *
 * Oxagen lists a tool to an agent only when some call to it could run. The
 * test asks Cedar with the call's facts unknown: the arguments, the taint,
 * the clock, the rate, the run, the budget, and the approval. Cedar
 * evaluates what it can and leaves the rest as a residual.
 *
 * A rule that forbids every call to the tool denies with nothing unknown,
 * so the tool is hidden. A rule that forbids only a refund over $100 depends
 * on the unknown amount, so Cedar reaches no decision and the tool stays
 * visible. A call that parks for approval can still run, so a tool whose
 * only certain deny is an approval rule stays visible too.
 */
import type { Context, CedarValueJson } from "@cedar-policy/cedar-wasm/nodejs";
import {
  BUILTIN_TOOLS,
  CALL_RESOURCE,
  harnessNamesSkill,
  isBuiltinAction,
  principalEntities,
  type CallTier,
  type CedarRuntime,
  type CedarToolClass,
} from "@oxagen/recorder/policy";
import type { CompiledPolicySet } from "./compile";

export interface VisibilityInput {
  runtime: CedarRuntime;
  policy: CompiledPolicySet;
  agent: string;
  /** An imported tool's `<server>__<tool>`, or a built-in action. */
  action: string;
  /** The tier, when the caller knows it. Unknown otherwise. */
  tier?: CallTier;
  /** The operator's role, when the caller knows it. Unknown otherwise. */
  operator_role?: string;
}

export interface Visibility {
  visible: boolean;
  /** For a hidden tool, the rules that deny every call to it. */
  reasons: string[];
  errors: string[];
}

function unknown(name: string): CedarValueJson {
  return { __extn: { fn: "unknown", arg: name } };
}

function toolContext(action: string, tool: CedarToolClass): CedarValueJson {
  return {
    name: action,
    version: tool.version,
    risk: tool.risk,
    side_effect: tool.side_effect,
    egress: tool.egress,
    impacts: [...tool.impacts],
  };
}

/**
 * The contexts to ask with. `mandate`, `harness_tool`, and `skill` are
 * optional in the schema, so a rule can test `context has mandate`. Each is
 * tried present with an unknown value and absent.
 */
function contexts(input: VisibilityInput, tool: CedarToolClass, namesSkill: boolean): Context[] {
  const base: Context = {
    tool: toolContext(input.action, tool),
    args: unknown("args"),
    taint: unknown("taint"),
    time: unknown("time"),
    rate: unknown("rate"),
    run: unknown("run"),
    operator: { role: input.operator_role ?? unknown("operator_role") },
    tier: input.tier ?? unknown("tier"),
    budget: unknown("budget"),
    approval: unknown("approval"),
  };
  const optional: [string, boolean][] = [
    ["mandate", true],
    ["harness_tool", true],
    ["skill", namesSkill],
  ];
  let variants: Context[] = [base];
  for (const [name, applies] of optional) {
    if (!applies) continue;
    variants = variants.flatMap((c) => [c, { ...c, [name]: unknown(name) }]);
  }
  return variants;
}

/**
 * Whether the agent can see the tool. Visible when some call to it could be
 * allowed or parked. Hidden when every call is denied, when the agent or the
 * tool is unknown, or when Cedar cannot evaluate a rule.
 */
export function toolVisibility(input: VisibilityInput): Visibility {
  const principal = input.policy.principals.find((p) => p.name === input.agent);
  if (principal === undefined) {
    return { visible: false, reasons: [], errors: [`The workspace declares no agent named ${input.agent}.`] };
  }
  const entry = Object.hasOwn(input.policy.tools, input.action)
    ? input.policy.tools[input.action]
    : undefined;
  const tool: CedarToolClass | undefined =
    entry !== undefined
      ? { version: entry.version, risk: entry.risk, side_effect: entry.side_effect, egress: entry.egress, impacts: entry.impacts }
      : isBuiltinAction(input.action)
        ? BUILTIN_TOOLS[input.action]
        : undefined;
  if (tool === undefined) {
    return { visible: false, reasons: [], errors: [`The workspace imported no tool named ${input.action}.`] };
  }

  const approval = new Set(input.policy.approval_ids);
  const entities = principalEntities(principal);
  const reasons = new Set<string>();
  const errors: string[] = [];
  for (const context of contexts(input, tool, harnessNamesSkill(principal.harness))) {
    const answer = input.runtime.isAuthorizedPartial({
      principal: { type: "Agent", id: principal.name },
      action: { type: "Action", id: input.action },
      resource: CALL_RESOURCE,
      context,
      policies: { staticPolicies: input.policy.policies },
      entities,
    });
    if (answer.type === "failure") {
      errors.push(...answer.errors.map((e) => e.message));
      continue;
    }
    const { decision, errored, mustBeDetermining } = answer.response;
    if (errored.length > 0) {
      errors.push(...errored.map((id) => `${id}: Cedar could not evaluate the rule.`));
      continue;
    }
    if (decision === null || decision === "allow") return { visible: true, reasons: [], errors: [] };
    if (mustBeDetermining.length > 0 && mustBeDetermining.every((id) => approval.has(id))) {
      return { visible: true, reasons: [], errors: [] };
    }
    for (const id of mustBeDetermining) reasons.add(id);
  }
  return { visible: false, reasons: [...reasons].sort(), errors };
}
