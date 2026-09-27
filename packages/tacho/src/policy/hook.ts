/**
 * Decides one tool call in `PreToolUse` from the Cedar policies in the cached
 * bundle (lane S12).
 *
 * The hook maps the harness's tool name to a Cedar action and asks Cedar
 * with the agent as the principal. A built-in tool maps through the
 * harness's table, so Claude Code's `Bash` and Codex's `shell` are both
 * `builtin__shell`. A direct MCP call, `mcp__<server>__<tool>`, is the action
 * `<server>__<tool>` when the workspace imported that tool, and
 * `builtin__shell` otherwise. A tool on Oxagen's own server
 * (`mcp__oxagen__…`) is left to the kernel, which decides it on the server
 * with the call's full context. The hook knows no taint, rate, or prior
 * calls, so it sends those parts empty, on the `harness` tier.
 */
import type { EntityJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { CedarBundle, CedarPrincipalEntry, CedarToolEntry } from "../wire";
import {
  BUILTIN_TOOLS,
  FALLBACK_BUILTIN,
  builtinActionFor,
  harnessNamesSkill,
  type BuiltinAction,
  type CedarToolClass,
} from "./builtins";
import { callContext, typedArgs, type CedarArgValue } from "./context";
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

const MCP_PREFIX = "mcp__";

/** The prefix of a tool on Oxagen's own MCP server. */
export const OXAGEN_TOOL_PREFIX = "mcp__oxagen__";

/**
 * Whether a harness tool is one of Oxagen's own. The kernel decides those on
 * the server, so the hook leaves them alone (tacho spec, section 7.2).
 */
export function isOxagenTool(toolName: string): boolean {
  return toolName.startsWith(OXAGEN_TOOL_PREFIX);
}

/**
 * The Cedar action id of a direct MCP call: `mcp__github__merge_pull_request`
 * is `github__merge_pull_request`. `undefined` for a name that is not an MCP
 * tool in that form, such as Cursor's `MCP:<tool>` when the payload named no
 * server.
 */
export function mcpActionFor(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined;
  const id = toolName.slice(MCP_PREFIX.length);
  const split = id.indexOf("__");
  return split > 0 && split < id.length - 2 ? id : undefined;
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
   * The tool's name as the harness sent it, when an adapter renamed it:
   * Cursor's `Shell` arrives as `Bash`. Rules read it in
   * `context.harness_tool`. Absent, `toolName` is the harness's own name.
   */
  harnessTool?: string;
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
  /** The Cedar action the call was decided as: a built-in, or an imported tool's `<server>__<tool>`. */
  action: string;
  /** The agents the call was decided for. Empty when no agent on this host runs the harness. */
  principals: string[];
}

/** The action a call is decided as, its classification, and each set of arguments it is decided with. */
interface HookRequest {
  action: string;
  tool: CedarToolClass;
  argSets: Record<string, CedarArgValue>[];
  /** Arguments of the wrong type. Any one of them denies the call. */
  errors: string[];
}

function importedToolRequest(
  action: string,
  tool: CedarToolEntry,
  input: Readonly<Record<string, unknown>> | undefined,
): HookRequest {
  const { args, errors } = typedArgs(input, tool.args);
  const { args: _types, ...classification } = tool;
  return { action, tool: classification, argSets: [args], errors };
}

function hookRequest(call: HookCedarCall): HookRequest {
  const mcpAction = call.action === undefined ? mcpActionFor(call.toolName) : undefined;
  if (mcpAction !== undefined && Object.hasOwn(call.cedar.tools, mcpAction)) {
    return importedToolRequest(
      mcpAction,
      call.cedar.tools[mcpAction] as CedarToolEntry,
      call.toolInput,
    );
  }
  // A direct MCP tool the workspace did not import is decided as the shell,
  // the strictest built-in, like any other tool the hook cannot name.
  const action =
    call.action ??
    (mcpAction !== undefined ? FALLBACK_BUILTIN : builtinActionFor(call.harness, call.toolName));
  return {
    action,
    tool: BUILTIN_TOOLS[action],
    argSets: builtinArgSets(call.toolName, call.toolInput),
    errors: [],
  };
}

/**
 * Cedar's decision for one tool call, or `null` for one of Oxagen's own
 * tools, which the kernel decides. The strictest verdict across the call's
 * agents and argument sets wins. A call no agent on this host can own is
 * denied: the grant permits nothing to an agent the steering record does
 * not declare.
 */
export function evaluateHookCall(call: HookCedarCall): HookCedarVerdict | null {
  if (isOxagenTool(call.toolName)) return null;
  const request = hookRequest(call);
  const { action } = request;
  const principals = principalsFor(call.cedar, call.harness, call.agent);
  if (principals.length === 0) {
    return { decision: "deny", reasons: [], errors: [], action, principals: [] };
  }
  const names = principals.map((p) => p.name);
  if (request.errors.length > 0) {
    return { decision: "deny", reasons: [], errors: request.errors, action, principals: names };
  }
  const skill =
    call.skill !== undefined && harnessNamesSkill(call.harness) ? call.skill : undefined;
  let verdict: CedarVerdict | undefined;
  for (const principal of principals) {
    const entities = principalEntities(principal);
    for (const args of request.argSets) {
      const context = callContext({
        tool: { name: action, ...request.tool },
        args,
        now: call.now,
        tier: "harness",
        ...(principal.operator_role !== undefined
          ? { operator_role: principal.operator_role }
          : {}),
        ...(principal.budget_remaining_cents !== undefined
          ? { budget_remaining_cents: principal.budget_remaining_cents }
          : {}),
        harness_tool: call.harnessTool ?? call.toolName,
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
  return { ...(verdict as CedarVerdict), action, principals: names };
}
