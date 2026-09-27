/**
 * The built-in tool vocabulary (steering-repo-spec, Built-in tools).
 *
 * Every harness names its own tools: Claude Code's `Bash`, Codex's `shell`,
 * stella's `bash`. Cedar sees one action for all of them, `builtin__shell`,
 * so one policy covers every harness. A rule for one harness tests
 * `principal.harness`, and `context.harness_tool` carries the harness's own
 * name.
 *
 * A harness tool with no entry here is decided as `builtin__shell`, the
 * strictest built-in, so a tool a harness adds tomorrow is never looser than
 * the shell.
 *
 * This module lives in `@oxagen/tacho` because the hook decides built-in
 * calls from the cached bundle and tacho has no `@oxagen/*` dependency.
 * `@oxagen/policy` reads it through `@oxagen/tacho/policy`, so the publish
 * side and the hook share one map.
 */

/** The server name built-in tools use. Mirrors `BUILTIN_SERVER` in `@oxagen/oxagen/steering-repo`. */
export const BUILTIN_SERVER = "builtin" as const;

export const BUILTIN_NAMES = [
  "shell",
  "read_file",
  "search_files",
  "write_file",
  "web_fetch",
  "web_search",
  "start_subagent",
] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];
export type BuiltinAction = `builtin__${BuiltinName}`;

/** A tool's classification, in the values of `tool.classification.ts`. */
export interface CedarToolClass {
  version: number;
  risk: "low" | "medium" | "high" | "critical";
  side_effect: "read" | "write" | "irreversible";
  egress: "local" | "org_tenant" | "third_party";
  impacts: string[];
}

/** The classification of each built-in action, from the spec's table. */
export const BUILTIN_TOOLS: Readonly<Record<BuiltinAction, CedarToolClass>> = {
  builtin__shell: { version: 1, risk: "high", side_effect: "irreversible", egress: "third_party", impacts: [] },
  builtin__read_file: { version: 1, risk: "low", side_effect: "read", egress: "local", impacts: [] },
  builtin__search_files: { version: 1, risk: "low", side_effect: "read", egress: "local", impacts: [] },
  builtin__write_file: { version: 1, risk: "medium", side_effect: "write", egress: "local", impacts: [] },
  builtin__web_fetch: { version: 1, risk: "medium", side_effect: "read", egress: "third_party", impacts: [] },
  builtin__web_search: { version: 1, risk: "low", side_effect: "read", egress: "third_party", impacts: [] },
  builtin__start_subagent: { version: 1, risk: "low", side_effect: "read", egress: "local", impacts: [] },
};

/** The action every unmapped harness tool is decided as. */
export const FALLBACK_BUILTIN: BuiltinAction = "builtin__shell";

/**
 * The harnesses the map covers: every `agent/v1` harness, plus
 * `claude-desktop`, which tacho enrolls.
 */
export const CEDAR_HARNESSES = [
  "claude-code",
  "claude-agent-sdk",
  "claude-desktop",
  "codex",
  "cursor",
  "stella",
  "custom",
] as const;
export type CedarHarness = (typeof CEDAR_HARNESSES)[number];

const CLAUDE_TOOLS: Readonly<Record<string, BuiltinName>> = {
  Bash: "shell",
  BashOutput: "shell",
  KillShell: "shell",
  KillBash: "shell",
  Read: "read_file",
  LS: "read_file",
  NotebookRead: "read_file",
  Grep: "search_files",
  Glob: "search_files",
  Edit: "write_file",
  Write: "write_file",
  MultiEdit: "write_file",
  NotebookEdit: "write_file",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Task: "start_subagent",
  Agent: "start_subagent",
};

/**
 * Each harness's tool names. Cursor's hook payload arrives translated to
 * Claude Code's names (`cursorToolName`), so its map holds both spellings.
 * A `custom` harness has no fixed tools, so every one of its tools is
 * decided as the shell.
 */
export const HARNESS_BUILTIN_MAP: Readonly<Record<CedarHarness, Readonly<Record<string, BuiltinName>>>> = {
  "claude-code": CLAUDE_TOOLS,
  "claude-agent-sdk": CLAUDE_TOOLS,
  "claude-desktop": CLAUDE_TOOLS,
  codex: {
    shell: "shell",
    local_shell: "shell",
    exec_command: "shell",
    Bash: "shell",
    apply_patch: "write_file",
    web_search: "web_search",
  },
  cursor: {
    Shell: "shell",
    Bash: "shell",
    Read: "read_file",
    Grep: "search_files",
    Glob: "search_files",
    Write: "write_file",
    Edit: "write_file",
    Delete: "write_file",
    Task: "start_subagent",
  },
  stella: {
    bash: "shell",
    read_file: "read_file",
    search: "search_files",
    write_file: "write_file",
    edit_file: "write_file",
    delete_file: "write_file",
    delegate: "start_subagent",
  },
  custom: {},
};

export function isCedarHarness(harness: string): harness is CedarHarness {
  return (CEDAR_HARNESSES as readonly string[]).includes(harness);
}

/** `builtin__shell` for `Bash` on Claude Code, and `builtin__shell` for anything unmapped. */
export function builtinActionFor(harness: string, harnessTool: string): BuiltinAction {
  if (!isCedarHarness(harness)) return FALLBACK_BUILTIN;
  const map = HARNESS_BUILTIN_MAP[harness];
  const name = Object.hasOwn(map, harnessTool) ? map[harnessTool] : undefined;
  return name === undefined ? FALLBACK_BUILTIN : `builtin__${name}`;
}

/**
 * The built-in actions one harness is granted: every action its map reaches,
 * plus `builtin__shell`, which its unmapped tools reach. Sorted.
 */
export function harnessBuiltinActions(harness: string): BuiltinAction[] {
  const actions = new Set<BuiltinAction>([FALLBACK_BUILTIN]);
  if (isCedarHarness(harness)) {
    for (const name of Object.values(HARNESS_BUILTIN_MAP[harness])) {
      actions.add(`builtin__${name}`);
    }
  }
  return [...actions].sort();
}

export function isBuiltinAction(action: string): action is BuiltinAction {
  return Object.hasOwn(BUILTIN_TOOLS, action);
}

/**
 * The harnesses whose hook events name the skill a subagent runs. Claude
 * Code and the Claude Agent SDK send `agent_type` on every hook event inside
 * a subagent. On every other harness a subagent's call is decided as the
 * main agent's, and the Skills screen warns that a skill's limit does not
 * hold there.
 */
export const HARNESSES_NAMING_SKILL: readonly CedarHarness[] = ["claude-code", "claude-agent-sdk"];

/** The harnesses that never name the skill, for the Skills screen's warning. */
export const HARNESSES_WITHOUT_SKILL: readonly CedarHarness[] = CEDAR_HARNESSES.filter(
  (h) => !HARNESSES_NAMING_SKILL.includes(h),
);

export function harnessNamesSkill(harness: string): boolean {
  return (HARNESSES_NAMING_SKILL as readonly string[]).includes(harness);
}
