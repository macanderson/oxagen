/**
 * The Cursor hook adapter (verified 2026-09-18 against
 * https://cursor.com/docs/agent/hooks, fetched that day; the page carries no
 * visible date). Cursor's hook surface differs from Claude Code's in both
 * directions, and this module is the one place that knows it, so the
 * recorder, the policy evaluator and the daemon keep reading one payload
 * shape.
 *
 * Nothing here is reused from Claude Code's path, because Cursor matches it
 * on none of the three things that would have allowed it:
 *
 *   - the session is `conversation_id` ("Stable ID of the conversation
 *     across many turns"), not `session_id`, so `hookInputSchema` rejects a
 *     Cursor payload outright;
 *   - the events are camelCase (`preToolUse`), not PascalCase (`PreToolUse`);
 *   - the answer is a flat permission object, not `hookSpecificOutput`.
 *
 * Cursor does support importing third-party hook config. Oxagen does not use
 * it, for three reasons: `.claude/settings.json` is Claude Code's file, so on
 * a machine running both, one definition would fire from two harnesses and
 * attribute Cursor's actions to the Claude Code chain; Cursor's docs specify
 * response, hook-name and tool-name translation but say nothing about
 * whether the stdin field names are translated, so the whole thing would
 * rest on an unverified assumption; and a user can turn third-party import
 * off, which would stop the mandate being enforced with no signal.
 *
 * In: every hook receives `conversation_id`, `generation_id`, `model`,
 * `model_id`, `model_params`, `hook_event_name`, `cursor_version`,
 * `workspace_roots`, `user_email` and `transcript_path`; `sessionStart` and
 * `sessionEnd` also carry `session_id`, documented as the same value as
 * `conversation_id`; `preToolUse` carries `tool_name`, `tool_input`,
 * `tool_use_id`, `cwd` and `agent_message`. Cursor issues both the session id
 * and the tool-use id, so unlike Stella nothing has to be synthesized from a
 * pid or a digest of the call. `postToolUse` carries `tool_output`;
 * `subagentStart`/`subagentStop` carry `subagent_id` and `subagent_type`.
 * Cursor names its built-in tools `Shell`, `Read`, `Write`, `Grep`, `Delete`,
 * `Task` and an MCP tool `MCP:<tool>`; the adapter renames them to Claude
 * Code's names (`Bash` for `Shell`, the rest pass through or keep their
 * name) so one policy rule (`Bash`, `mcp__server__*`) governs every harness.
 * The original name stays on the event as `cursor_tool_name`.
 *
 * Out: `preToolUse` and `subagentStart` answer `{"permission":
 * "allow"|"deny", "user_message", "agent_message"}`. `beforeSubmitPrompt`
 * answers `{"continue": true|false, "user_message"}`. `sessionStart`
 * answers `{"env", "additional_context"}` and cannot veto. `stop` takes a
 * `followup_message`. Every other event Oxagen registers answers nothing, so
 * it gets `{}`.
 *
 * **`ask` does not survive here, and it is degraded to `deny`, never to
 * `allow`.** Cursor's docs say `ask` "is accepted by the schema but not
 * enforced for `preToolUse` today". `beforeShellExecution` and
 * `beforeMCPExecution` do honour it, but they fire for two tool types that
 * `preToolUse` already covers, so registering there as well would record two
 * frames for one shell call and the trace oracles would read the second as a
 * replay. Oxagen therefore enforces at `preToolUse` (and, for a subagent
 * launch, `subagentStart`) alone and answers an `ask` with a deny whose
 * reason says a person has to approve it in Oxagen. Letting an `ask` through
 * as an allow would be a mandate that does not hold.
 *
 * **The tool names are translated, and the original is kept.** Claude Code's
 * `Bash` is Cursor's `Shell`; the rest of Cursor's built-ins (`Read`,
 * `Write`, `Grep`, `Task`) share Claude Code's name already. `Delete` and
 * `Glob` have no counterpart in the other vocabulary and pass through
 * unchanged. `classifyTool` (`./tools.ts`) reads the translated name, so a
 * `Shell` command still reaches the git-effect classification that turns
 * `git push` into `git_push`, and `cursor_tool_name` keeps the name Cursor
 * actually reported for anyone reading the raw attributes.
 *
 * **A signed-in address is dropped, not passed through.** Cursor may send
 * one as `user_email`; keeping it would land plaintext in every event's
 * attributes and in `raw_source_digest`, which is the confirmation-oracle
 * problem the Anthropic email scrub already prevents. `model_params` is
 * dropped for the same reason it never reaches an attribute from Claude
 * Code's path: it is a settings bag nothing here reads.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Cursor's hook events, and the Claude Code event each becomes. Only the
 * events Oxagen registers are here. `beforeShellExecution`,
 * `beforeMCPExecution`, `beforeReadFile` and `afterFileEdit` are deliberately
 * absent: each fires for a tool type `preToolUse` and `postToolUse` already
 * cover, and a second frame for one call is a false repeat, not more record.
 */
export const CURSOR_TO_CLAUDE_EVENT = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  stop: "Stop",
} as const;

export type CursorHookEventName = keyof typeof CURSOR_TO_CLAUDE_EVENT;

export const CURSOR_HOOK_EVENTS = Object.keys(
  CURSOR_TO_CLAUDE_EVENT,
) as CursorHookEventName[];

/**
 * The events at which Cursor lets a hook refuse (see the module comment):
 * a tool call, a subagent launch, and a prompt.
 */
export const CURSOR_ENFORCEMENT_EVENTS: readonly CursorHookEventName[] = [
  "beforeSubmitPrompt",
  "preToolUse",
  "subagentStart",
];

/** Cursor built-in tool → Claude Code tool, so one rule governs both. */
const CURSOR_TOOL_NAMES: Record<string, string> = {
  Shell: "Bash",
  Read: "Read",
  Write: "Write",
  Grep: "Grep",
  Task: "Task",
};

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
 * recorder keeps it as an attribute. A document that is not a Cursor payload
 * (no string `hook_event_name`, or no session to file it under) is returned
 * unchanged and fails the hook schema the way any junk does.
 *
 * Three members are dropped rather than passed through:
 *
 *   - `user_email`, because the address is not Oxagen's to keep (see the
 *     module comment);
 *   - `model_params`, a settings bag nothing here reads and which would be
 *     JSON-stringified into one attribute on every event;
 *   - `session_id` / `conversation_id` as separate members, since one of
 *     them becomes `session_id` and repeating the other adds no fact
 *     (Cursor's own session id survives as `cursor_session_id`).
 */
export function translateCursorPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const event = str(raw["hook_event_name"]);
  if (event === undefined || !(event in CURSOR_TO_CLAUDE_EVENT)) return raw;
  const {
    hook_event_name: _event,
    conversation_id: conversationId,
    session_id: cursorSessionId,
    generation_id: generationId,
    user_email: _email,
    model_params: _modelParams,
    cwd,
    tool_name: toolName,
    tool_output: toolOutput,
    tool_input: toolInput,
    workspace_roots: workspaceRoots,
    subagent_id: subagentId,
    subagent_type: subagentType,
    duration,
    ...rest
  } = raw;
  // `session_id` is documented as the same value as `conversation_id` and is
  // present only on sessionStart and sessionEnd, so the conversation id is
  // what every event is filed under. Cursor's own session id, when it sent
  // one, survives as an attribute rather than being dropped.
  const id = str(conversationId) ?? str(cursorSessionId);
  if (id === undefined) return raw;
  // A root is an initial location, not evidence that a later hook moved.
  // Mark inferred values so the daemon can retain the session's last cwd.
  const workspaceRoot = Array.isArray(workspaceRoots)
    ? str(workspaceRoots[0])
    : undefined;
  const derivedCwd = str(cwd) ?? workspaceRoot;
  const out: Record<string, unknown> = {
    ...rest,
    session_id: id,
    hook_event_name: CURSOR_TO_CLAUDE_EVENT[event as CursorHookEventName],
    ...(derivedCwd !== undefined ? { cwd: derivedCwd } : {}),
    ...(str(cwd) === undefined && workspaceRoot !== undefined
      ? { cursor_cwd_inferred: true }
      : {}),
    // A generation "changes with every user message", which is a turn.
    ...(str(generationId) !== undefined ? { turn_id: str(generationId) } : {}),
  };
  if (workspaceRoots !== undefined) out["workspace_roots"] = workspaceRoots;
  if (str(cursorSessionId) !== undefined)
    out["cursor_session_id"] = cursorSessionId;
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

const ASK_SUFFIX =
  "A person has to approve this in Oxagen before it can run; Cursor does not enforce an ask at preToolUse.";

/**
 * Claude Code's answer as Cursor's stdout (JSON plus a newline), for the
 * Claude Code event name the translated payload carries. Precedence runs
 * from most to least restrictive, so a document carrying two answers never
 * fails open: deny > ask > stop > allow.
 *
 * An allow at a permission event (`PreToolUse`, `SubagentStart`) is written
 * out as `{"permission": "allow"}` rather than `{}`. Every hook Oxagen
 * registers there sets `failClosed: true`, and Cursor counts "no output"
 * among the failures that block, so an empty document is not a thing to rely
 * on for an allow.
 */
export function cursorAnswer(
  response: Record<string, unknown>,
  claudeEvent: string,
): string {
  const specific = isRecord(response["hookSpecificOutput"])
    ? response["hookSpecificOutput"]
    : {};
  const permission = specific["permissionDecision"];
  const permissionReason = specific["permissionDecisionReason"];
  const stopped = response["continue"] === false;
  const blocked = stopped || response["decision"] === "block";
  const stopReason = stopped ? response["stopReason"] : response["reason"];
  const emit = (document: Record<string, unknown>): string =>
    `${JSON.stringify(document)}\n`;

  let refusal: string | undefined;
  if (permission === "deny")
    refusal = reasonOf(permissionReason, "Denied by Oxagen policy.");
  else if (permission === "ask")
    refusal = `${reasonOf(permissionReason, "Oxagen policy asks for approval.")} ${ASK_SUFFIX}`;
  else if (blocked)
    refusal = reasonOf(
      stopReason,
      stopped ? "Stopped by Oxagen policy." : "Blocked by Oxagen policy.",
    );

  switch (claudeEvent) {
    case "PreToolUse":
    case "SubagentStart": {
      if (refusal !== undefined)
        return emit({
          permission: "deny",
          user_message: refusal,
          agent_message: refusal,
        });
      return emit({ permission: "allow" });
    }
    case "UserPromptSubmit": {
      if (refusal !== undefined)
        return emit({ continue: false, user_message: refusal });
      return emit({ continue: true });
    }
    case "SessionStart": {
      // Cursor's sessionStart answer has no veto field, so a suspended host
      // cannot be stopped here. It is told why in prose, and preToolUse
      // refuses every call while the block holds.
      if (refusal !== undefined)
        return emit({
          additional_context: `Oxagen: ${refusal} Tool calls will be refused.`,
        });
      const context = specific["additionalContext"];
      return typeof context === "string" && context.length > 0
        ? emit({ additional_context: context })
        : emit({});
    }
    case "Stop": {
      // Claude Code's `decision: "block"` on Stop means "keep going, because
      // <reason>"; Cursor's counterpart is a follow-up message.
      if (blocked && typeof response["reason"] === "string")
        return emit({ followup_message: response["reason"] });
      return emit({});
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const context = specific["additionalContext"];
      return typeof context === "string" && context.length > 0
        ? emit({ additional_context: context })
        : emit({});
    }
    default:
      return emit({});
  }
}
