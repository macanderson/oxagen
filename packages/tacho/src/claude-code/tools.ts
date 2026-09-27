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
  return value.length > TARGET_MAX ? cutAt(value, TARGET_MAX) : value;
}

/**
 * The first `max` UTF-16 units of `value`, one fewer when the cut would fall
 * between the two halves of a surrogate pair. A lone high surrogate is not
 * valid Unicode: ClickHouse stores it as a replacement character, and the
 * stored target then no longer hashes to what the collector sealed.
 */
export function cutAt(value: string, max: number): string {
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
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
 * Whether an MCP tool opens a pull request. The effect is the same wherever
 * it is hosted, so this reads the tool name and not the server, and it reads
 * the words of the name rather than its spelling: GitHub servers name the
 * tool `create_pull_request`, `github_create_pull_request`,
 * `createPullRequest` or `pull_request_create`. A name that goes on past the
 * pull request (`create_pull_request_review`) does something else.
 */
function opensPullRequest(tool: string): boolean {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const last = words.slice(-3).join("_");
  return last === "create_pull_request" || last === "pull_request_create";
}

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
 * line to something this module cannot read. `tokenizeSimpleCommand` refuses
 * a command containing any of them outside quotes; `classifyShellEffect`
 * first splits a line at `&&`, `||`, `;` and newlines with
 * `splitCommandList`, and what is left of these (a pipe, a background `&`,
 * a subshell) still refuses the piece that holds it.
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
      // A backslash before a newline continues the line, and the shell
      // removes both, so `git push \<newline> origin` is `git push origin`.
      if (next === "\n") {
        i += 1;
        continue;
      }
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
 * The simple commands of one shell line, cut where the shell runs one after
 * another: an unquoted `&&`, `||`, `;` or newline. Quotes and backslashes are
 * tracked the way `tokenizeSimpleCommand` tracks them, so a separator inside
 * an argument does not cut, and each piece still goes through that tokenizer,
 * which refuses a piece holding a pipe, a background `&` or a subshell.
 *
 * An unquoted `<<` opens a here-document whose body is text rather than
 * commands, so nothing after the line that opens it is returned: a body line
 * that reads `git push` is not a push.
 */
export function splitCommandList(command: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let heredoc = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    const next = command[i + 1];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += char + next;
      i += 1;
      continue;
    }
    // A `#` that starts a word comments out the rest of the line, and a
    // `;` or `&&` in the comment separates nothing.
    if (char === "#" && (current.length === 0 || /\s$/.test(current))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (char === "<" && next === "<") heredoc = true;
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pieces.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === ";" || char === "\n") {
      pieces.push(current);
      current = "";
      if (char === "\n" && heredoc) return pieces;
      continue;
    }
    current += char;
  }
  pieces.push(current);
  return pieces;
}

/** Which effect a line reports when its commands have several: the furthest reaching. */
const EFFECT_REACH: readonly EffectKind[] = [
  "pr_open",
  "git_push",
  "git_commit",
];

/**
 * The effect kind a shell command declares, for the three effects that have a
 * kind of their own: a commit, a push, and opening a pull request.
 *
 * A line of several commands (`git push && gh pr create --fill`,
 * `cd repo && git commit -m x`) is read one command at a time. One frame
 * carries one effect kind, so a line that both pushes and opens a pull
 * request reports the pull request, and one that commits and pushes reports
 * the push.
 *
 * Undefined means the line is a plain `command`, and that is the answer for
 * everything this function is not sure of: a pipe or a subshell, an unknown
 * git option, a dry run, a subcommand that only reads. `git status` and
 * `echo git push` both land there, the first because `status` changes nothing
 * and the second because its first token is `echo`.
 */
export function classifyShellEffect(command: string): EffectKind | undefined {
  let found: EffectKind | undefined;
  for (const piece of splitCommandList(command)) {
    const effect = classifySimpleEffect(piece);
    if (
      effect !== undefined &&
      (found === undefined ||
        EFFECT_REACH.indexOf(effect) < EFFECT_REACH.indexOf(found))
    ) {
      found = effect;
    }
  }
  return found;
}

/** A leading `NAME=value` sets a variable for the command and is not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Where `gh` options that precede the subcommand end: `gh -R owner/repo pr
 * create` names the repository before `pr`.
 */
function ghSubcommandIndex(tokens: string[]): number {
  const first = tokens[1] ?? "";
  if (first === "-R" || first === "--repo") return 3;
  if (first.startsWith("--repo=") || /^-R./.test(first)) return 2;
  return 1;
}

function classifySimpleEffect(command: string): EffectKind | undefined {
  const words = tokenizeSimpleCommand(command);
  if (words === undefined) {
    return undefined;
  }
  // `GH_TOKEN=… gh pr create` is `gh pr create` with one more variable set.
  const start = words.findIndex((word) => !ASSIGNMENT.test(word));
  if (start === -1) {
    return undefined;
  }
  const tokens = words.slice(start);
  const program = tokens[0] as string;
  if (program === "gh") {
    const at = ghSubcommandIndex(tokens);
    if (tokens[at] !== "pr" || tokens[at + 1] !== "create") return undefined;
    // `--dry-run` prints what it would do and `--web` opens a browser for a
    // person to finish or abandon. Neither creates a pull request by itself,
    // so counting either would put one on the run's record that may not
    // exist. The git branches below make the same exclusion.
    return tokens.includes("--dry-run") || tokens.includes("--web")
      ? undefined
      : "pr_open";
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
      effect_kind: opensPullRequest(tool ?? "") ? "pr_open" : "network",
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

/** A pull request's page on github.com: owner, repository and number. */
const PULL_REQUEST_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/;

/**
 * The pull request a `pr_open` call created, read from the call's response
 * as the attrs `pr.url`, `pr.number` and `pr.repository`, or `{}` when the
 * response names none. `gh pr create` prints the new pull request's URL on
 * stdout, so stdout is read first; the rest of the response (an MCP server's
 * JSON) is read after it. The first URL is taken, and a branch's
 * `/pull/new/<branch>` hint from `git push` is not a pull request.
 */
export function pullRequestAttrs(response: unknown): Record<string, string> {
  const stdout =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)["stdout"]
      : undefined;
  const texts = [
    typeof stdout === "string" ? stdout : "",
    typeof response === "string" ? response : (JSON.stringify(response) ?? ""),
  ];
  for (const text of texts) {
    const match = PULL_REQUEST_URL.exec(text);
    if (match === null) continue;
    return {
      "pr.url": match[0],
      "pr.number": match[3] as string,
      "pr.repository": `${match[1]}/${match[2]}`,
    };
  }
  return {};
}

/**
 * The issue a tool call acted on, as the frame attrs `issue.repository`
 * (`owner/repo`), `issue.number`, `issue.url` and `issue.action` (one of
 * `get_run_issues`' actions), or `{}` when the call names none (#3970). The
 * sources are the GitHub MCP issue tools, keyed off the tool name after the
 * server prefix with `owner`, `repo` and `issue_number` in their input, and
 * the created issue's URL in a `gh issue create` or MCP create response.
 * `hooks.ts` merges them into the effect frame's attrs beside
 * `pullRequestAttrs`.
 *
 * The control plane reads a command frame's head for `gh issue <verb> N`
 * itself, so this names only what the head cannot carry: the issue a GitHub
 * MCP call acted on, whose input the frame keeps as a digest, and the number
 * `gh issue create` prints once the issue exists.
 */
export function issueAttrs(
  toolName: string,
  input: unknown,
  response: unknown,
): Record<string, string> {
  const fields =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  if (toolName === "Bash" || toolName === "Shell") {
    const command = fields["command"];
    if (typeof command !== "string" || !createsIssue(command)) return {};
    const created = issueUrlIn(response);
    return created === null ? {} : issueAttrsOf({ ...created, action: "created" });
  }
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(toolName);
  const cursor = mcp === null ? /^MCP:(.+)$/.exec(toolName) : null;
  const tool = mcp?.[1] ?? cursor?.[1];
  if (tool === undefined) return {};
  const action = mcpIssueAction(tool, fields);
  if (action === undefined) return {};
  const owner = fields["owner"];
  const repo = fields["repo"];
  const number = positiveNumber(fields["issue_number"] ?? fields["issueNumber"]);
  const created = action === "created" ? issueUrlIn(response) : null;
  if (created !== null) return issueAttrsOf({ ...created, action });
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !REPO_SEGMENT.test(owner) ||
    !REPO_SEGMENT.test(repo) ||
    number === undefined
  )
    return {};
  return issueAttrsOf({
    repository: `${owner}/${repo}`,
    number,
    url: `https://github.com/${owner}/${repo}/issues/${String(number)}`,
    action,
  });
}

/**
 * The release a GitHub MCP call created, as the frame attrs
 * `release.repository` (`owner/repo`) and `release.tag`, or `{}` when the
 * call created none (#3890). `get_run_work` reads the tag of a `gh release
 * create` from the command head, and these attrs for the MCP call, whose
 * input the frame keeps only as a digest. The tool name is read by its
 * words, so `create_release`, `github_create_release` and `createRelease`
 * read alike.
 */
export function releaseAttrs(
  toolName: string,
  input: unknown,
): Record<string, string> {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(toolName);
  const cursor = mcp === null ? /^MCP:(.+)$/.exec(toolName) : null;
  const tool = mcp?.[1] ?? cursor?.[1];
  if (tool === undefined) return {};
  const name = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .join("_");
  if (!/(^|_)(create_release|release_create)$/.test(name)) return {};
  const fields =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const owner = fields["owner"];
  const repo = fields["repo"];
  const tag = fields["tag_name"] ?? fields["tagName"] ?? fields["tag"];
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof tag !== "string" ||
    !REPO_SEGMENT.test(owner) ||
    !REPO_SEGMENT.test(repo) ||
    !/^[^\s-][^\s]{0,254}$/.test(tag)
  )
    return {};
  return { "release.repository": `${owner}/${repo}`, "release.tag": tag };
}

/** An issue's page on github.com: owner, repository and number. */
const ISSUE_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\b/;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function positiveNumber(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function issueAttrsOf(issue: {
  repository: string;
  number: number;
  url: string;
  action: string;
}): Record<string, string> {
  return {
    "issue.repository": issue.repository,
    "issue.number": String(issue.number),
    "issue.url": issue.url,
    "issue.action": issue.action,
  };
}

/** The first issue URL a response names: stdout first, then the rest of it. */
function issueUrlIn(
  response: unknown,
): { repository: string; number: number; url: string } | null {
  const stdout =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)["stdout"]
      : undefined;
  const texts = [
    typeof stdout === "string" ? stdout : "",
    typeof response === "string" ? response : (JSON.stringify(response) ?? ""),
  ];
  for (const text of texts) {
    const match = ISSUE_URL.exec(text);
    const number = positiveNumber(match?.[3]);
    if (match === null || number === undefined) continue;
    return {
      repository: `${match[1] as string}/${match[2] as string}`,
      number,
      url: match[0],
    };
  }
  return null;
}

/** Whether a shell line runs `gh issue create` in one of its commands. */
function createsIssue(command: string): boolean {
  for (const piece of splitCommandList(command)) {
    const tokens = tokenizeSimpleCommand(piece.split("|", 1)[0] ?? "");
    if (tokens === undefined) continue;
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? ""))
      i += 1;
    if (tokens[i]?.split("/").at(-1) !== "gh") continue;
    // The subcommand words, past the repository option and any flag: `gh -R
    // o/r issue create` and `gh issue create -t x` both read issue, create.
    const words: string[] = [];
    for (let j = i + 1; j < tokens.length && words.length < 2; j += 1) {
      const token = tokens[j] as string;
      if (token === "-R" || token === "--repo") j += 1;
      else if (!token.startsWith("-")) words.push(token);
    }
    if (words[0] === "issue" && words[1] === "create") return true;
  }
  return false;
}

/**
 * What a GitHub MCP issue tool does to its issue, keyed off the words of the
 * tool name so `create_issue`, `github_create_issue`, `createIssue` and
 * `issue_create` read alike. `issue_read` reads, `add_issue_comment`
 * comments, and `issue_write` or `update_issue` edits, closes or reopens by
 * the `method` and `state` it was called with. Undefined for a tool that
 * acts on no single issue (`list_issues`, `search_issues`).
 */
function mcpIssueAction(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  const name = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .join("_");
  const ends = (suffix: string) => name === suffix || name.endsWith(`_${suffix}`);
  const state = input["state"];
  const bystate = (fallback: string) =>
    state === "closed" ? "closed" : state === "open" ? "reopened" : fallback;
  if (ends("issue_read") || ends("get_issue") || ends("get_issue_comments"))
    return "viewed";
  if (ends("add_issue_comment") || ends("issue_comment_create")) return "commented";
  if (ends("create_issue") || ends("issue_create")) return "created";
  // Before `issue_write`, whose words it ends with: it links a sub-issue to
  // the issue it names, which edits that issue.
  if (ends("sub_issue_write")) return "edited";
  if (ends("issue_write"))
    return input["method"] === "create" ? "created" : bystate("edited");
  if (ends("update_issue") || ends("issue_update")) return bystate("edited");
  return undefined;
}
