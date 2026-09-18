/**
 * The Cursor hook adapter (verified 2026-09-18 against
 * cursor.com/docs/agent/hooks). Cursor's agent, in the IDE and in the `agent`
 * CLI, reads `hooks.json` and runs each entry as a command with the payload
 * on stdin, like Claude Code. The shapes differ in both directions, and this
 * module is the one place that knows it, so the recorder, the policy
 * evaluator and the daemon keep reading one payload shape.
 *
 * In: camelCase event names (`preToolUse`, `beforeSubmitPrompt`, `stop`) in
 * `hook_event_name`; the session is `conversation_id` on every agent event
 * (`sessionStart` and `sessionEnd` also carry a `session_id`, kept as
 * `cursor_session_id`); a tool's result is `tool_output`; the working
 * directory is `cwd` when the event has one and `workspace_roots[0]`
 * otherwise. Cursor names its built-in tools `Shell`, `Read`, `Write`,
 * `Grep`, `Delete`, `Task` and an MCP tool `MCP:<tool>`; the adapter renames
 * them to Claude Code's names so one policy rule (`Bash`, `mcp__server__*`)
 * governs every harness. The original name stays on the event as
 * `cursor_tool_name`.
 *
 * Out: Cursor reads a flat document per event. `preToolUse` and
 * `subagentStart` answer `{"permission": "allow" | "deny"}`; Cursor treats an
 * invalid or non-conforming answer to a permission event as a block, so those
 * events always answer one or the other. There is no `ask` on `preToolUse`:
 * a policy that asks for approval is answered `deny` with the reason, which
 * is the fail-closed reading. `beforeSubmitPrompt` answers `{"continue":
 * bool}`. `sessionStart` cannot refuse a session, so a stop there becomes
 * `additional_context` telling the agent why its tool calls will be refused,
 * and `preToolUse` refuses them while the block holds. `stop` takes a
 * `followup_message`, which is where Claude Code's "block the stop, keep
 * going because <reason>" lands.
 */

/** Cursor event → the Claude Code event the recorder and daemon read. */
export const CURSOR_EVENT_NAMES = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  stop: "Stop",
  sessionEnd: "SessionEnd",
} as const;

export type CursorHookEventName = keyof typeof CURSOR_EVENT_NAMES;

/** Cursor built-in tool → Claude Code tool, so one rule governs both. */
const CURSOR_TOOL_NAMES: Record<string, string> = {
  Shell: "Bash",
  Read: "Read",
  Write: "Write",
  Grep: "Grep",
  Task: "Task",
};

/** Members the translation renames; the rest pass through as attributes. */
const RENAMED_MEMBERS = [
  "conversation_id",
  "hook_event_name",
  "session_id",
  "tool_name",
  "tool_output",
  "tool_input",
  "workspace_roots",
  "subagent_id",
  "subagent_type",
  "duration",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Cursor's tool name in Claude Code's vocabulary. `MCP:<tool>` becomes
 * `mcp__<server>__<tool>` when the payload names the server, and stays as
 * sent when it does not: inventing a server would attribute the call to one
 * the agent never used. A name Claude Code has no counterpart for (`Delete`)
 * passes through.
 */
export function cursorToolName(name: string, mcpServer?: unknown): string {
  const mcp = /^MCP:(.+)$/.exec(name);
  if (mcp !== null) {
    return typeof mcpServer === "string" && mcpServer.length > 0
      ? `mcp__${mcpServer}__${mcp[1]}`
      : name;
  }
  return CURSOR_TOOL_NAMES[name] ?? name;
}

/**
 * Cursor's payload in Claude Code's hook shape. Renamed members are replaced
 * by their Claude Code names; every other member passes through so the
 * recorder keeps it as an attribute. A document that is not a Cursor agent
 * payload (no string `conversation_id` or no known event) is returned
 * unchanged and fails the hook schema the way any junk does.
 */
export function translateCursorPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const event = raw["hook_event_name"];
  const conversation = raw["conversation_id"];
  if (
    typeof event !== "string" ||
    typeof conversation !== "string" ||
    !(event in CURSOR_EVENT_NAMES)
  )
    return raw;
  const rest: Record<string, unknown> = { ...raw };
  for (const key of RENAMED_MEMBERS) delete rest[key];
  const cursorSessionId = raw["session_id"];
  const toolName = raw["tool_name"];
  const toolOutput = raw["tool_output"];
  const toolInput = raw["tool_input"];
  const workspaceRoots = raw["workspace_roots"];
  const subagentId = raw["subagent_id"];
  const subagentType = raw["subagent_type"];
  const duration = raw["duration"];
  const out: Record<string, unknown> = {
    ...rest,
    session_id: conversation,
    hook_event_name: CURSOR_EVENT_NAMES[event as CursorHookEventName],
    cursor_event: event,
  };
  if (cursorSessionId !== undefined) out["cursor_session_id"] = cursorSessionId;
  if (workspaceRoots !== undefined) out["workspace_roots"] = workspaceRoots;
  if (out["cwd"] === undefined && Array.isArray(workspaceRoots)) {
    const root: unknown = workspaceRoots[0];
    if (typeof root === "string") out["cwd"] = root;
  }
  if (typeof toolName === "string") {
    out["tool_name"] = cursorToolName(toolName, raw["mcp_server_name"]);
    out["cursor_tool_name"] = toolName;
  }
  if (isRecord(toolInput)) out["tool_input"] = toolInput;
  else if (typeof toolInput === "string") {
    // Cursor sends an MCP call's arguments as a JSON string.
    try {
      const parsed = JSON.parse(toolInput) as unknown;
      out["tool_input"] = isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      out["tool_input"] = { value: toolInput };
    }
  } else if (toolInput !== undefined) out["tool_input"] = { value: toolInput };
  if (toolOutput !== undefined) out["tool_response"] = toolOutput;
  if (typeof duration === "number") out["duration_ms"] = duration;
  if (typeof subagentId === "string") out["agent_id"] = subagentId;
  if (typeof subagentType === "string") out["agent_type"] = subagentType;
  return out;
}

function reasonOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Claude Code's answer as Cursor's stdout, with its trailing newline. `event`
 * is the Claude Code event name (the translated one). Precedence runs from
 * most to least restrictive, so a document carrying two answers never fails
 * open: deny > ask (answered deny) > stop > allow.
 */
export function cursorAnswer(
  response: Record<string, unknown>,
  event: string,
): string {
  const specific = isRecord(response["hookSpecificOutput"])
    ? response["hookSpecificOutput"]
    : {};
  const permission = specific["permissionDecision"];
  const permissionReason = specific["permissionDecisionReason"];
  const stopped = response["continue"] === false;
  const blocked = response["decision"] === "block";
  const stopReason = stopped ? response["stopReason"] : response["reason"];
  const answer = (document: Record<string, unknown>): string =>
    `${JSON.stringify(document)}\n`;
  const refuse = (reason: string): string =>
    answer({ permission: "deny", user_message: reason, agent_message: reason });

  switch (event) {
    case "PreToolUse":
    case "SubagentStart": {
      if (permission === "deny")
        return refuse(reasonOf(permissionReason, "Denied by Oxagen policy."));
      if (permission === "ask")
        return refuse(
          `${reasonOf(permissionReason, "Oxagen policy asks for approval.")} Cursor cannot pause for approval here, so the call is refused.`,
        );
      if (stopped || blocked)
        return refuse(reasonOf(stopReason, "Stopped by Oxagen policy."));
      return answer({ permission: "allow" });
    }
    case "UserPromptSubmit": {
      if (stopped || blocked)
        return answer({
          continue: false,
          user_message: reasonOf(stopReason, "Blocked by Oxagen policy."),
        });
      return answer({ continue: true });
    }
    case "SessionStart": {
      if (stopped || blocked)
        return answer({
          additional_context: `Oxagen: ${reasonOf(stopReason, "This session is stopped by its Oxagen operator.")} Tool calls will be refused.`,
        });
      const context = specific["additionalContext"];
      return typeof context === "string" && context.length > 0
        ? answer({ additional_context: context })
        : answer({});
    }
    case "Stop": {
      // Claude Code's `decision: "block"` on Stop means "keep going, because
      // <reason>"; Cursor's counterpart is a follow-up message.
      if (blocked && typeof response["reason"] === "string")
        return answer({ followup_message: response["reason"] });
      return answer({});
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const context = specific["additionalContext"];
      return typeof context === "string" && context.length > 0
        ? answer({ additional_context: context })
        : answer({});
    }
    default:
      return answer({});
  }
}
