// What a tool step actually did, read out of the body the recorder kept.
//
// A tool frame's body is JSON: `tool_call` holds `{input, output}` together
// (tacho `toolCallContent`), `tool_requested` holds the bare input, and a
// producer that records a content block holds `{tool_use: {name, input}}`.
// Before this module the transcript printed that JSON at the reader and let
// them find the command in it. The point here is that a reader should never
// have to: the step line says which tool ran and what it ran on, and the
// panes below it show the command, the diff or the contents as source, not as
// an escaped string inside an object.
//
// Three rules hold everywhere below:
//
//  1. **Nothing is invented.** A field the body did not carry is null, and the
//     surface leaves it out rather than drawing a placeholder. The digest is a
//     reading of the record, never an addition to it.
//  2. **An unknown tool still reads.** A tool this module has no shape for
//     falls back to its input's first useful string, then to pretty-printed
//     JSON in a `json` pane — which is strictly better than the raw one-line
//     JSON it replaced, and never worse.
//  3. **Pure.** No React, no formatting, no i18n. It is tested without a
//     render, and the view decides how much of what it returns to show.

import { type CodeLanguage, languageForPath } from "@/shared/code-highlight";
import { buildDiff, type LineDiff } from "@/shared/line-diff";

/**
 * The family a tool belongs to. It decides the icon, and only the icon.
 *
 * Grouping rather than one icon per tool is deliberate: a reader scanning a
 * long run is looking for "where did it touch the disk" and "where did it run
 * something", not for the difference between `Grep` and `Glob`. The tool's
 * own name is always written beside the icon, so the group never has to carry
 * a distinction the name already makes.
 */
export type ToolGroup =
  | "shell"
  | "read"
  | "edit"
  | "create"
  | "delete"
  | "search"
  | "web"
  | "skill"
  | "agent"
  | "plan"
  | "notebook"
  | "mcp"
  | "tool";

/** One block of content under a step: source, a diff, or plain prose. */
/**
 * What a pane holds, as a key the surface translates.
 *
 * A key rather than a heading, because this module is pure and the app is
 * translated: a literal here would be one English word the catalogue never
 * sees, in a file no translator opens.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export type PaneLabel =
  | "command"
  | "output"
  | "diff"
  | "contents"
  | "asked"
  | "arguments"
  | "brief"
  | "plan"
  | "input"
  | "reply";

/** One pane of a tool reading.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export type ToolPane =
  | {
      kind: "code";
      /** What the pane holds, for the heading above it. */
      label: PaneLabel;
      text: string;
      language: CodeLanguage;
      /** The line number the first line carries. */
      startLine: number;
      /** Lines shown before the reader expands it; null shows all of them. */
      preview: number | null;
    }
  | { kind: "diff"; label: PaneLabel; path: string; diff: LineDiff }
  | { kind: "note"; label: PaneLabel; text: string };

export type ToolDetail = {
  /** The tool's own name, as the producer recorded it. */
  name: string;
  group: ToolGroup;
  /**
   * The one line that says what the step acted on: a command's first line, a
   * file's path, a search's pattern, a skill's name. Null when the body
   * carried nothing worth a headline, and the surface then shows the name
   * alone rather than an empty slot.
   */
  headline: string | null;
  /** A short qualifier after the headline, such as a skill's version. */
  detail: string | null;
  /** True when the headline is the first line of something longer. */
  multiline: boolean;
  panes: ToolPane[];
};

// ── Reading the body ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Json | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The first of `keys` the object carries as a non-empty string. */
function firstStr(source: Json | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = str(source, key);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The body text as JSON, or null when it is not JSON at all.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function parseBody(text: string | null): unknown {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // Cheap gate before the parse: a truncated body is common here, and a
  // failed parse on every frame of a long run is not free.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The tool's input and output, whichever of the recorded shapes carried them.
 *
 * `tool_call` writes `{input, output}`; `tool_requested` writes the input on
 * its own; a content-block producer writes `{tool_use: {name, input}}`. A
 * body that matches none of these is treated as the input itself, which is
 * what the bare-input shape already is.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function splitBody(parsed: unknown): {
  input: Json | null;
  output: unknown;
  name: string | null;
} {
  if (!isObject(parsed)) return { input: null, output: null, name: null };
  const use = parsed["tool_use"];
  if (isObject(use)) {
    return {
      input: isObject(use["input"]) ? use["input"] : null,
      output: parsed["tool_result"] ?? null,
      name: str(use, "name"),
    };
  }
  if ("input" in parsed || "output" in parsed) {
    return {
      input: isObject(parsed["input"]) ? parsed["input"] : null,
      output: parsed["output"] ?? null,
      name: str(parsed, "name"),
    };
  }
  return { input: parsed, output: null, name: null };
}

/** The output's text, however the producer spelled it. */
function outputText(output: unknown): string | null {
  if (typeof output === "string") return output === "" ? null : output;
  if (!isObject(output)) return null;
  const stdout = str(output, "stdout");
  const stderr = str(output, "stderr");
  if (stdout !== null || stderr !== null) {
    return [stdout, stderr].filter((part) => part !== null).join("\n");
  }
  return firstStr(output, "text", "content", "result", "output", "message");
}

// ── Naming ──────────────────────────────────────────────────────────────────

const GROUPS: Readonly<Record<string, ToolGroup>> = {
  bash: "shell",
  bashoutput: "shell",
  killshell: "shell",
  shell: "shell",
  run_command: "shell",
  terminal: "shell",
  read: "read",
  readfile: "read",
  view: "read",
  cat: "read",
  edit: "edit",
  multiedit: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  applypatch: "edit",
  write: "create",
  writefile: "create",
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

/**
 * The family a tool name belongs to; `mcp__server__tool` is always `mcp`.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function groupOf(name: string): ToolGroup {
  if (name.startsWith("mcp__")) return "mcp";
  return GROUPS[name.toLowerCase()] ?? "tool";
}

/** An `mcp__server__tool` name as the server and tool a reader recognises. */
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const [, server, ...rest] = name.split("__");
  if (server === undefined || rest.length === 0) return null;
  return { server, tool: rest.join("__") };
}

/**
 * A path as the reader knows it: the last two segments, never the whole tree.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function shortPath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

// ── Per-tool readings ───────────────────────────────────────────────────────

/**
 * How many lines of a created file or a fetched body open expanded.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const CREATE_PREVIEW = 20;
/**
 * How many lines of a read file, a command's output or an unknown input open
 * expanded.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const OUTPUT_PREVIEW = 5;

function firstLine(text: string): { head: string; multiline: boolean } {
  const index = text.indexOf("\n");
  if (index === -1) return { head: text, multiline: false };
  return { head: text.slice(0, index), multiline: true };
}

function shellDetail(
  name: string,
  input: Json | null,
  output: unknown,
): ToolDetail {
  const command = firstStr(input, "command", "cmd", "script");
  const description = firstStr(input, "description");
  const panes: ToolPane[] = [];
  if (command !== null) {
    panes.push({
      kind: "code",
      label: "command",
      text: command,
      language: "shell",
      startLine: 1,
      // A one-line command is already in the headline, so its pane opens
      // whole; a longer one opens at the line the headline showed and the
      // reader unfolds the rest.
      preview: command.includes("\n") ? 1 : null,
    });
  }
  const out = outputText(output);
  if (out !== null) {
    panes.push({
      kind: "code",
      label: "output",
      text: out,
      language: "text",
      startLine: 1,
      preview: OUTPUT_PREVIEW,
    });
  }
  const head = command === null ? null : firstLine(command);
  return {
    name,
    group: groupOf(name),
    headline: head?.head ?? description,
    detail: command === null ? null : description,
    multiline: head?.multiline ?? false,
    panes,
  };
}

function pathOf(input: Json | null): string | null {
  return firstStr(
    input,
    "file_path",
    "filePath",
    "path",
    "notebook_path",
    "target_file",
  );
}

function readDetail(name: string, input: Json | null): ToolDetail {
  const path = pathOf(input);
  const offset = input?.["offset"];
  const limit = input?.["limit"];
  const range =
    typeof offset === "number" || typeof limit === "number"
      ? `lines ${String(typeof offset === "number" ? offset + 1 : 1)}${
          typeof limit === "number"
            ? `–${String((typeof offset === "number" ? offset : 0) + limit)}`
            : "+"
        }`
      : null;
  return {
    name,
    group: groupOf(name),
    headline: path === null ? null : shortPath(path),
    detail: range,
    multiline: false,
    panes: [],
  };
}

/** One `old_string`/`new_string` pair as a diff pane. */
function editPane(path: string, before: string, after: string): ToolPane {
  return {
    kind: "diff",
    label: "diff",
    path,
    diff: buildDiff(before, after),
  };
}

function editDetail(name: string, input: Json | null): ToolDetail {
  const path = pathOf(input) ?? "(no path recorded)";
  const panes: ToolPane[] = [];
  const edits = input?.["edits"];
  if (Array.isArray(edits)) {
    // MultiEdit: every replacement against the same file, in the order it
    // was applied. Each is its own diff, because they are separate changes.
    for (const edit of edits) {
      if (!isObject(edit)) continue;
      const before = firstStr(edit, "old_string", "oldString") ?? "";
      const after = firstStr(edit, "new_string", "newString") ?? "";
      panes.push(editPane(path, before, after));
    }
  } else {
    const before = firstStr(input, "old_string", "oldString");
    const after = firstStr(input, "new_string", "newString");
    if (before !== null || after !== null) {
      panes.push(editPane(path, before ?? "", after ?? ""));
    }
  }
  const total = panes.reduce(
    (sum, pane) => (pane.kind === "diff" ? sum + pane.diff.added : sum),
    0,
  );
  const cut = panes.reduce(
    (sum, pane) => (pane.kind === "diff" ? sum + pane.diff.removed : sum),
    0,
  );
  return {
    name,
    group: groupOf(name),
    headline: shortPath(path),
    detail: panes.length === 0 ? null : `+${String(total)} −${String(cut)}`,
    multiline: false,
    panes,
  };
}

function createDetail(name: string, input: Json | null): ToolDetail {
  const path = pathOf(input);
  const content = firstStr(input, "content", "contents", "text", "new_string");
  const panes: ToolPane[] = [];
  if (content !== null) {
    panes.push({
      kind: "code",
      label: "contents",
      text: content,
      language: path === null ? "text" : languageForPath(path),
      startLine: 1,
      preview: CREATE_PREVIEW,
    });
  }
  const lineCount = content === null ? null : content.split("\n").length;
  return {
    name,
    group: groupOf(name),
    headline: path === null ? null : shortPath(path),
    detail: lineCount === null ? null : `${String(lineCount)} lines`,
    multiline: false,
    panes,
  };
}

function searchDetail(name: string, input: Json | null): ToolDetail {
  const pattern = firstStr(input, "pattern", "query", "regex", "glob");
  const where = firstStr(input, "path", "directory", "include", "cwd");
  return {
    name,
    group: groupOf(name),
    headline: pattern,
    detail: where === null ? null : `in ${shortPath(where)}`,
    multiline: false,
    panes: [],
  };
}

function webDetail(name: string, input: Json | null): ToolDetail {
  const url = firstStr(input, "url", "query");
  const prompt = firstStr(input, "prompt");
  return {
    name,
    group: groupOf(name),
    headline: url,
    detail: null,
    multiline: false,
    panes:
      prompt === null ? [] : [{ kind: "note", label: "asked", text: prompt }],
  };
}

/**
 * A skill load. The version is only ever what the body recorded: a skill that
 * shipped no version reads as the skill's name alone, because a version the
 * record does not hold is not one this page may print.
 */
function skillDetail(name: string, input: Json | null): ToolDetail {
  const skill = firstStr(input, "skill", "name", "id");
  const version = firstStr(input, "version", "skill_version", "v");
  const args = firstStr(input, "args", "arguments", "input");
  return {
    name,
    group: "skill",
    headline: skill,
    detail: version === null ? null : `v${version.replace(/^v/, "")}`,
    multiline: false,
    panes:
      args === null ? [] : [{ kind: "note", label: "arguments", text: args }],
  };
}

function agentDetail(name: string, input: Json | null): ToolDetail {
  const type = firstStr(input, "subagent_type", "agent_type", "type");
  const what = firstStr(input, "description", "name");
  const prompt = firstStr(input, "prompt", "task", "instructions");
  return {
    name,
    group: "agent",
    headline: what ?? type,
    detail: what !== null && type !== null ? type : null,
    multiline: false,
    panes:
      prompt === null ? [] : [{ kind: "note", label: "brief", text: prompt }],
  };
}

function planDetail(name: string, input: Json | null): ToolDetail {
  const todos = input?.["todos"];
  const count = Array.isArray(todos) ? todos.length : null;
  const plan = firstStr(input, "plan");
  return {
    name,
    group: "plan",
    headline:
      count === null
        ? plan === null
          ? null
          : firstLine(plan).head
        : `${String(count)} items`,
    detail: null,
    multiline: false,
    panes: plan === null ? [] : [{ kind: "note", label: "plan", text: plan }],
  };
}

/** Pretty JSON, so an unknown tool's input is at least readable as source. */
function jsonPane(label: PaneLabel, value: unknown): ToolPane | null {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text !== "string" || text === "{}" || text === "null")
      return null;
    return {
      kind: "code",
      label,
      text,
      language: "json",
      startLine: 1,
      preview: OUTPUT_PREVIEW,
    };
  } catch {
    return null;
  }
}

/**
 * A tool with no shape of its own. The headline is the input's first short
 * string value, which in practice is the thing the call was about, and the
 * whole input follows as formatted JSON.
 */
function genericDetail(
  name: string,
  input: Json | null,
  output: unknown,
): ToolDetail {
  const mcp = mcpParts(name);
  const candidate = Object.entries(input ?? {}).find(
    ([, value]) => typeof value === "string" && value !== "",
  );
  const raw = typeof candidate?.[1] === "string" ? candidate[1] : null;
  const head = raw === null ? null : firstLine(raw);
  const panes = [jsonPane("input", input), jsonPane("output", output)].filter(
    (pane): pane is ToolPane => pane !== null,
  );
  return {
    name: mcp === null ? name : mcp.tool,
    group: groupOf(name),
    headline: head?.head ?? null,
    detail: mcp?.server ?? null,
    multiline: head?.multiline ?? false,
    panes,
  };
}

/**
 * What the step did, read from the tool's name and the body the recorder
 * kept. `name` is the tool the frame identified; the body may name it again,
 * and the body wins only when the frame named nothing.
 */
export function toolDetail(
  name: string | null,
  body: string | null,
): ToolDetail | null {
  const parsed = parseBody(body);
  const { input, output, name: bodyName } = splitBody(parsed);
  const tool = name ?? bodyName;
  if (tool === null) return null;
  switch (groupOf(tool)) {
    case "shell":
      return shellDetail(tool, input, output);
    case "read":
      return readDetail(tool, input);
    case "edit":
      return editDetail(tool, input);
    case "create":
      return createDetail(tool, input);
    case "delete":
      return readDetail(tool, input);
    case "search":
      return searchDetail(tool, input);
    case "web":
      return webDetail(tool, input);
    case "skill":
      return skillDetail(tool, input);
    case "agent":
      return agentDetail(tool, input);
    case "plan":
      return planDetail(tool, input);
    case "notebook":
      return editDetail(tool, input);
    default:
      return genericDetail(tool, input, output);
  }
}
