/**
 * The family a tool belongs to, read from its recorded name: the one
 * vocabulary the transcript's entries carry (`TranscriptFold.family`) and the
 * Run page's figures count by (ADR-182).
 *
 * A family is a reading of a name and nothing more. It says whether a call
 * inspected, changed, ran or delegated something, so a reader can colour a
 * row and a figure can group calls. It never says what the call did: that is
 * the body's job.
 */

/** The families, in the order a reader meets them in a coding run. */
export const TOOL_FAMILIES = [
  "shell",
  "read",
  "edit",
  "create",
  "delete",
  "search",
  "web",
  "skill",
  "agent",
  "plan",
  "notebook",
  "mcp",
  "tool",
] as const;

export type ToolFamily = (typeof TOOL_FAMILIES)[number];

/** Known tool names, lowercased, by family. A name not listed is `tool`. */
const FAMILIES: Readonly<Record<string, ToolFamily>> = {
  bash: "shell",
  bashoutput: "shell",
  killshell: "shell",
  shell: "shell",
  run_command: "shell",
  terminal: "shell",
  read: "read",
  readfile: "read",
  read_file: "read",
  view: "read",
  cat: "read",
  get_file_contents: "read",
  edit: "edit",
  edit_file: "edit",
  multiedit: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  applypatch: "edit",
  write: "create",
  writefile: "create",
  write_file: "create",
  create: "create",
  createfile: "create",
  delete: "delete",
  remove: "delete",
  rm: "delete",
  grep: "search",
  glob: "search",
  search: "search",
  ls: "search",
  find: "search",
  codebase_search: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  skill: "skill",
  task: "agent",
  agent: "agent",
  subagent: "agent",
  todowrite: "plan",
  todoread: "plan",
  exitplanmode: "plan",
  notebookedit: "notebook",
  notebookread: "notebook",
};

/** The harnesses whose tool names a gateway records with a prefix (`claude_code__Bash`). */
const HARNESS_PREFIX = /^(claude_code|codex|stella|cursor)__/;

/**
 * A tool's name without the harness prefix a gateway adds and without a
 * trailing `@version`, so `claude_code__Bash` and `Read@2.1.4` name the tools
 * a harness calls `Bash` and `Read`.
 */
export function bareToolName(name: string): string {
  return name.replace(HARNESS_PREFIX, "").replace(/@[\d.]+$/, "");
}

/**
 * The family a tool name belongs to. Every `mcp__server__tool` is `mcp`,
 * whatever the tool is called, and a name nobody listed is `tool`.
 */
export function toolFamilyOf(name: string): ToolFamily {
  if (name.startsWith("mcp__")) return "mcp";
  return FAMILIES[bareToolName(name).toLowerCase()] ?? "tool";
}
