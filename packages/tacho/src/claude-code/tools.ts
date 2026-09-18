/**
 * What a tool call touches, classified from its name and input. Drives
 * `effect_kind`, `tool_target`, `tool_targets`, `tool_is_mutating`, and the
 * MCP server/tool split.
 *
 * Two vocabularies arrive here, and neither is rewritten before it does: a
 * record that renamed the tool would no longer say what the harness reported.
 * Claude Code (and Codex, and Stella) send `Bash`, `Edit`, `Glob`; Cursor
 * sends `Shell`, `Write`, `Delete` and `MCP:<tool_name>` (verified 2026-09-18
 * against https://cursor.com/docs/agent/hooks, fetched that day). `Shell` is
 * Claude Code's `Bash`, so it takes the same branch and still reaches the
 * git-effect classification; Cursor's `Write` covers both `Edit` and `Write`;
 * `Glob` has no Cursor equivalent, and `Delete` has no Claude Code one.
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
/**
 * MCP tools that open a pull request. The effect is the same wherever it is
 * hosted, so this matches the tool name and not the server.
 */
const PR_OPEN_MCP_TOOLS = new Set(["create_pull_request"]);

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

/**
 * Shell characters that end one simple command and begin another, or hand the
 * line to something this module cannot read. A command containing any of them
 * outside quotes is not classified: `git add . && git push` is a commit's
 * worth of work plus a push, and one frame carries one effect kind, so the
 * honest answer for a compound line is the generic `command`.
 */
const COMMAND_SEPARATORS = new Set(["&", "|", ";", "\n", "`", "(", ")"]);

/**
 * Split one shell line into whitespace-separated tokens, or return undefined
 * when the line is not a single simple command.
 *
 * Quotes are tracked so that a separator inside an argument does not split the
 * line: `git commit -m "fix: a; b"` is one command, and the `;` in the message
 * is message text. Quotes are stripped from the tokens, so the subcommand of
 * `git "push"` reads as `push`. A `$(` substitution returns undefined, because
 * what it expands to is not visible here.
 */
export function tokenizeSimpleCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        started = true;
        i += 1;
      }
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      return undefined;
    }
    if (COMMAND_SEPARATORS.has(char)) {
      return undefined;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== undefined) {
    return undefined;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Git options that sit before the subcommand and take a separate value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/** Git options that sit before the subcommand and take no value. */
const GIT_GLOBAL_FLAGS = new Set([
  "-P",
  "--paginate",
  "--no-pager",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
  "--no-lazy-fetch",
]);

/**
 * The subcommand of a `git` invocation, reading past the global options that
 * may precede it: `git -C /repo -c user.name=x push` answers `push`.
 *
 * An option this list does not know returns undefined rather than a guess,
 * because an unknown option that takes a separate value would make its value
 * read as the subcommand. A generic `command` frame is a smaller loss than a
 * frame that names the wrong effect.
 */
export function gitSubcommand(
  tokens: string[],
): { name: string; index: number } | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (!token.startsWith("-")) {
      return { name: token, index: i };
    }
    const base = token.startsWith("--")
      ? (token.split("=", 1)[0] as string)
      : token;
    if (token.includes("=") && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(base)) {
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(base)) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(base)) {
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The effect kind a shell command declares, for the three effects that have a
 * kind of their own: a commit, a push, and opening a pull request.
 *
 * Undefined means the line is a plain `command`, and that is the answer for
 * everything this function is not sure of: a compound line, an unknown git
 * option, a dry run, a subcommand that only reads. `git status` and
 * `echo git push` both land there, the first because `status` changes nothing
 * and the second because its first token is `echo`.
 */
export function classifyShellEffect(command: string): EffectKind | undefined {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }
  const program = tokens[0] as string;
  if (program === "gh") {
    return tokens[1] === "pr" && tokens[2] === "create" ? "pr_open" : undefined;
  }
  if (program !== "git") {
    return undefined;
  }
  const subcommand = gitSubcommand(tokens);
  if (subcommand === undefined) {
    return undefined;
  }
  if (subcommand.name !== "push" && subcommand.name !== "commit") {
    return undefined;
  }
  const args = tokens.slice(subcommand.index + 1);
  // A dry run reports what would happen and changes nothing, so it is a
  // command. `-n` is the short form for push; on commit it means --no-verify.
  if (args.includes("--dry-run")) {
    return undefined;
  }
  if (subcommand.name === "push") {
    return args.includes("-n") ? undefined : "git_push";
  }
  return "git_commit";
}

export function classifyTool(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): ToolClassification {
  const input = toolInput ?? {};
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  // Cursor spells an MCP call `MCP:<tool_name>` and names no server, so this
  // one carries `mcp_tool_name` without an `mcp_server_name`. Inventing a
  // server would put a name in the record that no harness reported.
  const cursorMcp = mcp === null ? /^MCP:(.+)$/.exec(toolName) : null;
  if (mcp || cursorMcp) {
    const [, server, tool] = mcp ?? [undefined, undefined, cursorMcp?.[1]];
    return {
      tool_source: "mcp",
      ...(server !== undefined ? { mcp_server_name: server } : {}),
      mcp_tool_name: tool as string,
      // Keyed off the tool name rather than the whole `mcp__…` string, so the
      // same capability on a second server classifies the same way.
      effect_kind: PR_OPEN_MCP_TOOLS.has(tool ?? "") ? "pr_open" : "network",
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
  if (toolName === "Delete") {
    const target = head(input["file_path"] ?? input["path"]);
    return {
      tool_source: "builtin",
      effect_kind: "file_delete",
      tool_is_mutating: true,
      ...(target !== undefined ? { tool_target: target } : {}),
    };
  }
  if (toolName === "Bash" || toolName === "Shell") {
    const raw = input["command"];
    const command = head(raw);
    const effect =
      typeof raw === "string" ? classifyShellEffect(raw) : undefined;
    return {
      tool_source: "builtin",
      effect_kind: effect ?? "command",
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
