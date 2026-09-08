/**
 * What a Claude Code tool call touches, classified from its name and input.
 * Drives `effect_kind`, `tool_target`, `tool_targets`, `tool_is_mutating`,
 * and the MCP server/tool split.
 */
import type { TachoEventBody } from "../envelope";

export type EffectKind = NonNullable<TachoEventBody["effect_kind"]>;
export type ToolSource = NonNullable<TachoEventBody["tool_source"]>;

export interface ToolClassification {
  tool_source: ToolSource;
  mcp_server_name?: string;
  mcp_tool_name?: string;
  effect_kind: EffectKind;
  tool_is_mutating: boolean;
  /** One human-meaningful target: a path, a URL host, or a command head. */
  tool_target?: string;
  /** Every path a multi-file tool names. */
  tool_targets?: string[];
}

const TARGET_MAX = 512;

function head(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.length > TARGET_MAX ? value.slice(0, TARGET_MAX) : value;
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  try {
    return new URL(url).host;
  } catch {
    return head(url);
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
const READ_ONLY_BUILTINS = new Set([
  ...READ_TOOLS,
  "TodoRead",
  "TaskList",
  "TaskGet",
  "ListAgents",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
]);

export function classifyTool(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): ToolClassification {
  const input = toolInput ?? {};
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (mcp) {
    const [, server, tool] = mcp;
    return {
      tool_source: "mcp",
      mcp_server_name: server,
      mcp_tool_name: tool,
      effect_kind: "network",
      tool_is_mutating:
        !/^(get|list|read|search|find|fetch|describe|query)/i.test(tool ?? ""),
      ...(head(input["url"]) !== undefined
        ? { tool_target: hostOf(input["url"]) }
        : {}),
    };
  }
  if (READ_TOOLS.has(toolName)) {
    const target = head(
      input["file_path"] ??
        input["path"] ??
        input["pattern"] ??
        input["notebook_path"],
    );
    return {
      tool_source: "builtin",
      effect_kind: "file_read",
      tool_is_mutating: false,
      ...(target !== undefined ? { tool_target: target } : {}),
    };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const target = head(input["file_path"]);
    return {
      tool_source: "builtin",
      effect_kind: "file_write",
      tool_is_mutating: true,
      ...(target !== undefined ? { tool_target: target } : {}),
    };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const target = head(input["file_path"] ?? input["notebook_path"]);
    const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
    const targets = [
      target,
      ...edits.map((edit) =>
        head((edit as Record<string, unknown>)["file_path"]),
      ),
    ].filter((value): value is string => value !== undefined);
    return {
      tool_source: "builtin",
      effect_kind: "file_edit",
      tool_is_mutating: true,
      ...(target !== undefined ? { tool_target: target } : {}),
      ...(targets.length > 1 ? { tool_targets: [...new Set(targets)] } : {}),
    };
  }
  if (toolName === "Bash") {
    const command = head(input["command"]);
    return {
      tool_source: "builtin",
      effect_kind: "command",
      tool_is_mutating: true,
      ...(command !== undefined ? { tool_target: command } : {}),
    };
  }
  if (NETWORK_TOOLS.has(toolName)) {
    const target = hostOf(input["url"]) ?? head(input["query"]);
    return {
      tool_source: "builtin",
      effect_kind: "network",
      tool_is_mutating: false,
      ...(target !== undefined ? { tool_target: target } : {}),
    };
  }
  if (toolName === "Task" || toolName === "Agent") {
    const target = head(input["subagent_type"] ?? input["description"]);
    return {
      tool_source: "builtin",
      effect_kind: "subagent",
      tool_is_mutating: false,
      ...(target !== undefined ? { tool_target: target } : {}),
    };
  }
  if (toolName === "Skill") {
    return {
      tool_source: "skill",
      effect_kind: "other",
      tool_is_mutating: false,
      ...(head(input["skill"]) !== undefined
        ? { tool_target: head(input["skill"]) }
        : {}),
    };
  }
  return {
    tool_source: "builtin",
    effect_kind: "other",
    tool_is_mutating: !READ_ONLY_BUILTINS.has(toolName),
  };
}

/** The first word of a shell command, for `tacho_session_commands.bash_command`. */
export function commandHead(command: string): string {
  const trimmed = command.trim();
  const match = /^[A-Za-z0-9_./-]+/.exec(trimmed);
  return match?.[0] ?? "";
}
