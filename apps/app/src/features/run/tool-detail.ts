// What a tool call actually did, read out of the body the recorder kept.
//
// A tool frame's body is JSON: `tool_call` holds `{input, output}` together
// (tacho `toolCallContent`), `tool_requested` holds the bare input, and a
// producer that records a content block holds `{tool_use: {name, input}}`.
// The transcript row for a call (mockup `txRow`, kind `tool`) leads with the
// tool's short name and what it acted on, and under it shows the output it
// read and, for an edit or a new file, the change as a diff. This module reads
// those out of the body so the row never prints the JSON at the reader.
//
// Three rules hold everywhere below:
//
//  1. **Nothing is invented.** A field the body did not carry is null, and the
//     surface leaves it out rather than drawing a placeholder.
//  2. **An unknown tool still reads.** A tool this module has no shape for
//     heads its line with its arguments in order, and keeps its input as
//     formatted JSON behind the row's fold.
//  3. **Pure.** No React, no formatting, no i18n. It is tested without a
//     render, and the view decides how much of what it returns to show.

import { buildDiff, type LineDiff } from "@/shared/line-diff";

/**
 * The family a tool belongs to. It decides the colour of the row's name
 * (`inspect`, `mutate`, `execute`, `delegate` in the design), and only that.
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

/** One change a call made to a file, as a diff of the two halves it recorded. */
export type ToolDiff = {
  path: string;
  diff: LineDiff;
  /** The call wrote a file that was not there: the diff is all additions. */
  created: boolean;
};

export type ToolDetail = {
  /** The tool's short name: no harness prefix, no version, no `mcp__`. */
  name: string;
  group: ToolGroup;
  /**
   * The one line that says what the call acted on: a command's first line, a
   * file's path, a search's pattern, the arguments of a tool with no shape.
   * Null when the body carried nothing worth a headline.
   */
  headline: string | null;
  /** A short qualifier after the headline, such as a read's line range. */
  detail: string | null;
  /** True when the headline is the first line of something longer. */
  multiline: boolean;
  /** The call as it was made: a command's whole text, or the input as formatted JSON. */
  raw: string | null;
  /** What the call returned, as text; null when the body kept no output. */
  output: string | null;
  diffs: ToolDiff[];
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
 * @internal Exported for its unit test and the transcript's model.
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

/**
 * The output's text, however the producer spelled it: a string, a shell's
 * streams, a text field, or a read's `file.content`. An output with none of
 * those is kept as formatted JSON rather than dropped.
 */
function outputText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return output === "" ? null : output;
  if (isObject(output)) {
    const stdout = str(output, "stdout");
    const stderr = str(output, "stderr");
    if (stdout !== null || stderr !== null) {
      return [stdout, stderr].filter((part) => part !== null).join("\n");
    }
    const file = output["file"];
    const content = isObject(file) ? str(file, "content") : null;
    if (content !== null) return content;
    const text = firstStr(
      output,
      "text",
      "content",
      "result",
      "output",
      "message",
    );
    if (text !== null) return text;
    // An object with only empty streams carried no text at all.
    if (
      Object.keys(output).every((key) => key === "stdout" || key === "stderr")
    )
      return null;
  }
  return pretty(output);
}

/** Formatted JSON, so a value with no text of its own still reads as source. */
function pretty(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text !== "string" || text === "{}" || text === "null")
      return null;
    return text;
  } catch {
    return null;
  }
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
 * A tool's name as a reader knows it (mockup `txToolName`): the harness
 * prefix and a trailing `@version` dropped, and an MCP tool named by its
 * server and tool (`mcp__github__create_release` reads `github__create_release`).
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function shortName(name: string): string {
  const bare = name.replace(HARNESS_PREFIX, "").replace(/@[\d.]+$/, "");
  return bare.startsWith("mcp__") ? bare.slice("mcp__".length) : bare;
}

/**
 * The family a tool name belongs to; `mcp__server__tool` is always `mcp`, and
 * an MCP tool whose own name has a shape (`github__get_file_contents`) takes it.
 *
 * @internal Exported for its unit test and the Run page's metrics.
 */
export function groupOf(name: string): ToolGroup {
  if (name.startsWith("mcp__")) return "mcp";
  const bare = name.replace(HARNESS_PREFIX, "").replace(/@[\d.]+$/, "");
  return GROUPS[bare.toLowerCase()] ?? "tool";
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

function firstLine(text: string): { head: string; multiline: boolean } {
  const index = text.indexOf("\n");
  if (index === -1) return { head: text, multiline: false };
  return { head: text.slice(0, index), multiline: true };
}

type Reading = Omit<ToolDetail, "name" | "group" | "raw" | "output"> & {
  raw?: string | null;
};

function shellReading(input: Json | null): Reading {
  const command = firstStr(input, "command", "cmd", "script");
  const description = firstStr(input, "description");
  const head = command === null ? null : firstLine(command);
  return {
    headline: head?.head ?? description,
    detail: command === null ? null : description,
    multiline: head?.multiline ?? false,
    // The command is the call; its JSON wrapper would only escape its lines.
    raw: command,
    diffs: [],
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

function readReading(input: Json | null): Reading {
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
    headline: path === null ? null : shortPath(path),
    detail: range,
    multiline: false,
    diffs: [],
  };
}

function editReading(input: Json | null): Reading {
  const path = pathOf(input) ?? "(no path recorded)";
  const diffs: ToolDiff[] = [];
  const edits = input?.["edits"];
  if (Array.isArray(edits)) {
    // MultiEdit: every replacement against the same file, in the order it
    // was applied. Each is its own diff, because they are separate changes.
    for (const edit of edits) {
      if (!isObject(edit)) continue;
      const before = firstStr(edit, "old_string", "oldString") ?? "";
      const after = firstStr(edit, "new_string", "newString") ?? "";
      diffs.push({ path, diff: buildDiff(before, after), created: false });
    }
  } else {
    const before = firstStr(input, "old_string", "oldString");
    const after = firstStr(input, "new_string", "newString");
    if (before !== null || after !== null) {
      diffs.push({
        path,
        diff: buildDiff(before ?? "", after ?? ""),
        created: false,
      });
    }
  }
  return {
    headline: shortPath(path),
    detail: null,
    multiline: false,
    diffs,
  };
}

/** A new file reads as the diff it is: every line an addition (`txDiffBlock`, "new file"). */
function createReading(input: Json | null): Reading {
  const path = pathOf(input);
  const content = firstStr(input, "content", "contents", "text", "new_string");
  return {
    headline: path === null ? null : shortPath(path),
    detail: null,
    multiline: false,
    diffs:
      content === null
        ? []
        : [
            {
              path: path ?? "(no path recorded)",
              diff: buildDiff("", content),
              created: true,
            },
          ],
  };
}

function searchReading(input: Json | null): Reading {
  const pattern = firstStr(input, "pattern", "query", "regex", "glob");
  const where = firstStr(input, "path", "directory", "include", "cwd");
  return {
    headline: pattern,
    detail: where === null ? null : `in ${shortPath(where)}`,
    multiline: false,
    diffs: [],
  };
}

function webReading(input: Json | null): Reading {
  return {
    headline: firstStr(input, "url", "query"),
    detail: null,
    multiline: false,
    diffs: [],
  };
}

/**
 * A skill load. The version is only ever what the body recorded: a skill that
 * shipped no version reads as the skill's name alone, because a version the
 * record does not hold is not one this page may print.
 */
function skillReading(input: Json | null): Reading {
  const version = firstStr(input, "version", "skill_version", "v");
  return {
    headline: firstStr(input, "skill", "name", "id"),
    detail: version === null ? null : `v${version.replace(/^v/, "")}`,
    multiline: false,
    diffs: [],
  };
}

function agentReading(input: Json | null): Reading {
  const type = firstStr(input, "subagent_type", "agent_type", "type");
  const what = firstStr(input, "description", "name");
  return {
    headline: what ?? type,
    detail: what !== null && type !== null ? type : null,
    multiline: false,
    diffs: [],
  };
}

function planReading(input: Json | null): Reading {
  const todos = input?.["todos"];
  const plan = firstStr(input, "plan");
  return {
    headline: Array.isArray(todos)
      ? `${String(todos.length)} items`
      : plan === null
        ? null
        : firstLine(plan).head,
    detail: null,
    multiline: false,
    diffs: [],
  };
}

/** A scalar argument as text; null for an object, an array or an empty string. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

/**
 * A tool with no shape of its own: its arguments on one line, in the order
 * the call gave them (mockup `txRow`, `.arg`). The first reads bare, because
 * it is nearly always what the call is about (a repository, a path, a query);
 * the rest read as `key value`, so `closed` is never left to mean itself.
 */
function genericReading(input: Json | null): Reading {
  const parts = Object.entries(input ?? {}).flatMap(([key, value], index) => {
    const text = scalar(value);
    if (text === null) return [];
    const { head } = firstLine(text);
    return [index === 0 ? head : `${key} ${head}`];
  });
  const firstValue = Object.values(input ?? {}).map(scalar)[0] ?? null;
  return {
    headline: parts.length === 0 ? null : parts.join(" · "),
    detail: null,
    multiline: firstValue === null ? false : firstLine(firstValue).multiline,
    diffs: [],
  };
}

function readingOf(group: ToolGroup, input: Json | null): Reading {
  switch (group) {
    case "shell":
      return shellReading(input);
    case "read":
    case "delete":
      return readReading(input);
    case "edit":
    case "notebook":
      return editReading(input);
    case "create":
      return createReading(input);
    case "search":
      return searchReading(input);
    case "web":
      return webReading(input);
    case "skill":
      return skillReading(input);
    case "agent":
      return agentReading(input);
    case "plan":
      return planReading(input);
    default:
      return genericReading(input);
  }
}

/**
 * What the call did, read from the tool's name and the body the recorder
 * kept. `name` is the tool the frame identified; the body may name it again,
 * and the body wins only when the frame named nothing.
 *
 * @internal Exported for its unit test; the transcript reads a body it has
 * already parsed, through `toolDetailOf`.
 */
export function toolDetail(
  name: string | null,
  body: string | null,
): ToolDetail | null {
  return toolDetailOf(name, parseBody(body));
}

/**
 * `toolDetail` over a value already parsed: a model's `tool_use` block, whose
 * input arrives as an object and was never a body of its own.
 */
export function toolDetailOf(
  name: string | null,
  parsed: unknown,
): ToolDetail | null {
  const { input, output, name: bodyName } = splitBody(parsed);
  const tool = name ?? bodyName;
  if (tool === null) return null;
  const group = groupOf(tool);
  const { raw, ...reading } = readingOf(group, input);
  return {
    name: shortName(tool),
    group,
    ...reading,
    raw: raw ?? pretty(input),
    output: outputText(output),
  };
}
