/**
 * Decides one built-in tool call in `PreToolUse` from the Cedar policies in
 * the cached bundle (lane S12).
 *
 * The hook maps the harness's tool name to a built-in action, so Claude
 * Code's `Bash` and Codex's `shell` are both `builtin__shell`, and asks
 * Cedar with the agent as the principal. A tool the gateway serves
 * (`mcp__…`) is left to the gateway, which sees the call's full context. The
 * hook knows no taint, rate, or prior calls, so it sends those parts empty,
 * on the `harness` tier.
 */
import type { EntityJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { CedarBundle, CedarPrincipalEntry } from "../wire";
import {
  BUILTIN_TOOLS,
  builtinActionFor,
  harnessNamesSkill,
  type BuiltinAction,
} from "./builtins";
import { callContext } from "./context";
import {
  readCedarDecision,
  stricterVerdict,
  type CedarVerdict,
} from "./decision";
import type { CedarRuntime } from "./runtime";

/** The resource every request names. Policies narrow on the call's context. */
export const CALL_RESOURCE = { type: "Target", id: "call" } as const;

export type CedarPrincipal = Pick<
  CedarPrincipalEntry,
  "name" | "operator" | "runtime" | "harness" | "workspace"
>;

/** The agent and its workspace, as Cedar entities. */
export function principalEntities(principal: CedarPrincipal): EntityJson[] {
  return [
    { uid: { type: "Workspace", id: principal.workspace }, attrs: {}, parents: [] },
    {
      uid: { type: "Agent", id: principal.name },
      attrs: {
        operator: principal.operator,
        runtime: principal.runtime,
        harness: principal.harness,
      },
      parents: [{ type: "Workspace", id: principal.workspace }],
    },
  ];
}

/**
 * The agents a call on this host could belong to. A custom agent names
 * itself (`tacho hook --agent <name>`). Any other call belongs to the agents
 * whose harness sent it. Two agents on one host with the same harness cannot
 * be told apart, so the call is decided for both and the stricter verdict
 * wins.
 */
export function principalsFor(
  cedar: CedarBundle,
  harness: string,
  agent: string | undefined,
): CedarPrincipalEntry[] {
  if (agent !== undefined) return cedar.principals.filter((p) => p.name === agent);
  return cedar.principals.filter((p) => p.harness === harness);
}

/** Whether a harness tool is one the gateway serves, which the hook leaves to the gateway. */
export function isGatewayTool(toolName: string): boolean {
  return toolName.startsWith("mcp__") || toolName.startsWith("MCP:");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** The files a Codex `apply_patch` touches, in order, once each. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(PATCH_FILE)) {
    const path = (match[1] as string).trim();
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * The built-in arguments of one call, in the schema's names: `path`,
 * `command`, `url`, `query`, `pattern`, and `subagent`. A patch that touches
 * three files is three sets, one per path, and the call is decided once for
 * each.
 */
export function builtinArgSets(
  harnessTool: string,
  input: Readonly<Record<string, unknown>> | undefined,
): Record<string, string>[] {
  const raw = input ?? {};
  const args: Record<string, string> = {};
  const path = text(raw["file_path"]) ?? text(raw["notebook_path"]) ?? text(raw["path"]);
  if (path !== undefined) args["path"] = path;
  const command = raw["command"];
  if (typeof command === "string" && command.length > 0) {
    args["command"] = command;
  } else if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    args["command"] = command.join(" ");
  }
  for (const name of ["url", "query", "pattern"] as const) {
    const value = text(raw[name]);
    if (value !== undefined) args[name] = value;
  }
  const subagent = text(raw["subagent_type"]);
  if (subagent !== undefined) args["subagent"] = subagent;

  if (harnessTool === "apply_patch") {
    const patch =
      text(raw["patch"]) ?? text(raw["input"]) ?? text(raw["value"]) ?? args["command"];
    const paths = patch === undefined ? [] : patchPaths(patch);
    if (paths.length > 0) {
      const { command: _patch, ...rest } = args;
      return paths.map((p) => ({ ...rest, path: p }));
    }
  }
  return [args];
}

export interface HookCedarCall {
  runtime: CedarRuntime;
  cedar: CedarBundle;
  /** The harness that sent the call. It names the tool, and it picks the agent. */
  harness: string;
  /** A custom agent's name, which picks the agent instead of the harness. */
  agent?: string;
  toolName: string;
  toolInput?: Readonly<Record<string, unknown>>;
  /**
   * The action, for a call the hook builds itself rather than one the harness
   * named: a subagent start is `builtin__start_subagent` on every harness.
   */
  action?: BuiltinAction;
  /** The skill a subagent runs, as the harness named it. Read only where the harness names skills. */
  skill?: string;
  now: number;
}

export interface HookCedarVerdict extends CedarVerdict {
  action: BuiltinAction;
  /** The agents the call was decided for. Empty when no agent on this host runs the harness. */
  principals: string[];
}

/**
 * Cedar's decision for one built-in call, or `null` for a tool the gateway
 * serves. The strictest verdict across the call's agents and argument sets
 * wins. A call no agent on this host can own is denied: the grant permits
 * nothing to an agent the steering record does not declare.
 */
export function evaluateHookCall(call: HookCedarCall): HookCedarVerdict | null {
  if (isGatewayTool(call.toolName)) return null;
  const action = call.action ?? builtinActionFor(call.harness, call.toolName);
  const principals = principalsFor(call.cedar, call.harness, call.agent);
  if (principals.length === 0) {
    return { decision: "deny", reasons: [], errors: [], action, principals: [] };
  }
  const skill =
    call.skill !== undefined && harnessNamesSkill(call.harness) ? call.skill : undefined;
  const argSets = builtinArgSets(call.toolName, call.toolInput);
  let verdict: CedarVerdict | undefined;
  for (const principal of principals) {
    const entities = principalEntities(principal);
    for (const args of argSets) {
      const context = callContext({
        tool: { name: action, ...BUILTIN_TOOLS[action] },
        args,
        now: call.now,
        tier: "harness",
        ...(principal.operator_role !== undefined
          ? { operator_role: principal.operator_role }
          : {}),
        ...(principal.budget_remaining_cents !== undefined
          ? { budget_remaining_cents: principal.budget_remaining_cents }
          : {}),
        harness_tool: call.toolName,
        ...(skill !== undefined ? { skill } : {}),
      });
      const answer = call.runtime.isAuthorized({
        principal: { type: "Agent", id: principal.name },
        action: { type: "Action", id: action },
        resource: CALL_RESOURCE,
        context,
        schema: call.cedar.schema,
        validateRequest: true,
        policies: { staticPolicies: call.cedar.policies },
        entities,
      });
      const next = readCedarDecision(answer, call.cedar.approval_ids);
      verdict = verdict === undefined ? next : stricterVerdict(verdict, next);
    }
  }
  return {
    ...(verdict as CedarVerdict),
    action,
    principals: principals.map((p) => p.name),
  };
}
