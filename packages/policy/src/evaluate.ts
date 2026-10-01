/**
 * Decides one tool call from a workspace's compiled policy set (lane S12).
 *
 * The request names the agent as the principal, the tool as the action, and
 * `Target::"call"` as the resource. The context is the agent policy spec's
 * `Call`, plus `harness_tool` and `skill`. The gateway knows the run's
 * taint, rate, and prior calls and passes them. A part the caller leaves out
 * takes `callContext`'s empty default.
 *
 * Cedar checks the request against the schema before it evaluates, so an
 * argument of the wrong type, or a context the schema does not describe,
 * denies the call instead of slipping past a rule.
 */
import type { CedarToolEntry } from "@oxagen/recorder";
import {
  BUILTIN_TOOLS,
  CALL_RESOURCE,
  builtinActionFor,
  builtinArgSets,
  callContext,
  harnessNamesSkill,
  isBuiltinAction,
  principalEntities,
  readCedarDecision,
  stricterVerdict,
  typedArgs,
  type CallTier,
  type CedarArgValue,
  type CedarRuntime,
  type CedarToolClass,
  type CedarVerdict,
} from "@oxagen/recorder/policy";
import type { CompiledPolicySet } from "./compile";
import { BUILTIN_ARG_TYPES } from "./schema";

export interface ToolCallInput {
  runtime: CedarRuntime;
  policy: CompiledPolicySet;
  /** The agent's name, from `agents/<name>.toml`. */
  agent: string;
  /**
   * The Cedar action: an imported tool's `<server>__<tool>`, or a built-in
   * such as `builtin__shell`. Absent, `harness_tool` names the call.
   */
  action?: string;
  /**
   * The tool's name as the harness sent it, such as Claude Code's `Bash`.
   * Rules read it in `context.harness_tool`. Without `action`, the call is
   * decided as the built-in the harness's map gives it, and a name the map
   * lacks is decided as `builtin__shell`.
   */
  harness_tool?: string;
  /**
   * The call's arguments. For an imported tool they are the tool's own. For
   * a built-in named by `action` they are Cedar's names (`command`, `path`,
   * `url`, `query`, `pattern`, `subagent`). For a built-in named only by
   * `harness_tool` they are the harness's input, mapped as the hook maps it.
   */
  args?: Readonly<Record<string, unknown>>;
  /** The tool version the call names. Absent, the version the workspace imported. */
  version?: number;
  /** The clock, as epoch ms. */
  now: number;
  /** The enforcement tier. The gateway decides on `gateway`. */
  tier?: CallTier;
  taint?: { tainted: boolean; sources: string[] };
  rate?: { calls_last_hour: number; calls_last_minute: number };
  run?: { prior_calls: string[]; prior_reads: string[] };
  /** Overrides the role in the agent's declaration. */
  operator_role?: string;
  /** Overrides the budget in the agent's declaration. */
  budget_remaining_cents?: number;
  mandate_remaining_cents?: number;
  approval?: { granted: boolean; approvers: number };
  /** The skill a subagent runs. Read only where the harness names skills. */
  skill?: string;
}

export interface ToolCallVerdict extends CedarVerdict {
  /** The action the call was decided as. Empty when the call named none. */
  action: string;
  agent: string;
  /**
   * True when the deny is an argument that does not fit its declared type,
   * so the caller's input is the fix. Absent for every other error, such as
   * an undeclared agent, a tool not imported, or a failure inside Cedar.
   */
  invalidArguments?: true;
}

interface ResolvedCall {
  action: string;
  tool: CedarToolClass;
  argSets: Record<string, CedarArgValue>[];
  errors: string[];
}

function importedCall(
  action: string,
  entry: CedarToolEntry,
  input: ToolCallInput,
): ResolvedCall {
  const { args, errors } = typedArgs(input.args, entry.args);
  const { args: _types, ...classification } = entry;
  const tool = input.version === undefined ? classification : { ...classification, version: input.version };
  return { action, tool, argSets: [args], errors };
}

function resolveCall(input: ToolCallInput, harness: string): ResolvedCall | { error: string } {
  const { action } = input;
  if (action !== undefined) {
    const entry = Object.hasOwn(input.policy.tools, action) ? input.policy.tools[action] : undefined;
    if (entry !== undefined) return importedCall(action, entry, input);
    if (isBuiltinAction(action)) {
      const { args, errors } = typedArgs(input.args, BUILTIN_ARG_TYPES);
      return { action, tool: BUILTIN_TOOLS[action], argSets: [args], errors };
    }
    return { error: `The workspace imported no tool named ${action}.` };
  }
  if (input.harness_tool === undefined) return { error: "The call names no tool." };
  const builtin = builtinActionFor(harness, input.harness_tool);
  return {
    action: builtin,
    tool: BUILTIN_TOOLS[builtin],
    argSets: builtinArgSets(input.harness_tool, input.args),
    errors: [],
  };
}

function deny(agent: string, action: string, errors: string[]): ToolCallVerdict {
  return { decision: "deny", reasons: [], errors, action, agent };
}

/**
 * Cedar's decision for one call: allow, deny, or `require_approval` when
 * every rule that denied it is an approval rule. An agent the workspace
 * does not declare, a tool it did not import, or an argument of the wrong
 * type is a deny with the reason in `errors`.
 */
export function decideToolCall(input: ToolCallInput): ToolCallVerdict {
  const principal = input.policy.principals.find((p) => p.name === input.agent);
  if (principal === undefined) {
    return deny(input.agent, input.action ?? "", [`The workspace declares no agent named ${input.agent}.`]);
  }
  const call = resolveCall(input, principal.harness);
  if ("error" in call) return deny(input.agent, input.action ?? "", [call.error]);
  if (call.errors.length > 0) return { ...deny(input.agent, call.action, call.errors), invalidArguments: true };

  const skill =
    input.skill !== undefined && harnessNamesSkill(principal.harness) ? input.skill : undefined;
  const operatorRole = input.operator_role ?? principal.operator_role;
  const budget = input.budget_remaining_cents ?? principal.budget_remaining_cents;
  const entities = principalEntities(principal);
  let verdict: CedarVerdict | undefined;
  for (const args of call.argSets) {
    const context = callContext({
      tool: { name: call.action, ...call.tool },
      args,
      now: input.now,
      tier: input.tier ?? "gateway",
      ...(input.taint !== undefined ? { taint: input.taint } : {}),
      ...(input.rate !== undefined ? { rate: input.rate } : {}),
      ...(input.run !== undefined ? { run: input.run } : {}),
      ...(operatorRole !== undefined ? { operator_role: operatorRole } : {}),
      ...(budget !== undefined ? { budget_remaining_cents: budget } : {}),
      ...(input.mandate_remaining_cents !== undefined
        ? { mandate_remaining_cents: input.mandate_remaining_cents }
        : {}),
      ...(input.approval !== undefined ? { approval: input.approval } : {}),
      ...(input.harness_tool !== undefined ? { harness_tool: input.harness_tool } : {}),
      ...(skill !== undefined ? { skill } : {}),
    });
    const answer = input.runtime.isAuthorized({
      principal: { type: "Agent", id: principal.name },
      action: { type: "Action", id: call.action },
      resource: CALL_RESOURCE,
      context,
      schema: input.policy.schema,
      validateRequest: true,
      policies: { staticPolicies: input.policy.policies },
      entities,
    });
    const next = readCedarDecision(answer, input.policy.approval_ids);
    verdict = verdict === undefined ? next : stricterVerdict(verdict, next);
  }
  return { ...(verdict as CedarVerdict), action: call.action, agent: principal.name };
}
