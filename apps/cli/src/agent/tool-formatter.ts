/**
 * Format agent tool calls for human-readable output.
 *
 * Maps tools to emojis, parses JSON inputs into readable summaries,
 * handles spacing between outputs.
 */

/** Emoji and color for each tool type. */
export const TOOL_EMOJIS: Record<string, string> = {
  // Core agent tools
  Read: "📖",
  Write: "✍️",
  Create: "🆕",
  Edit: "📝",
  Delete: "🗑️",
  Bash: "💻",

  // Knowledge & graph
  MCP: "🔗",
  query_ontology: "🔍",
  "knowledge.query": "🔍",

  // LLM & inference
  dispatch_subagent: "🚀",

  // Workflow & process
  run_workflow: "▶️",
  cancel_workflow: "⏹️",

  // Default — tools without a mapping render with no emoji at all.
  default: "",
};

/**
 * Get emoji for a tool name. Unmapped tools get an empty string — callers must
 * not assume a glyph is always present.
 */
export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] ?? "";
}

/**
 * Accent color (hex) for a tool chip, grouped by what the tool *does* so the
 * transcript reads at a glance: green = it wrote something, red = it destroyed
 * something, amber = it ran a command, violet = it delegated to a subagent,
 * cyan = it read/searched (the safe default).
 */
export function getToolAccent(toolName: string): string {
  const n = toolName.toLowerCase();
  if (isSubagentDispatch(toolName)) return "#A78BFA"; // violet — delegation
  if (/(^|[.\-_])(delete|remove|rm|drop)([.\-_]|$)/.test(n)) return "#FB7185"; // red
  if (/(^|[.\-_])(write|edit|create|update|patch|apply)([.\-_]|$)/.test(n))
    return "#34D399"; // green
  if (/(bash|shell|exec|command|run|terminal)/.test(n)) return "#FBBF24"; // amber
  return "#7CE8F4"; // cyan — read / search / query
}

/**
 * Human-facing label for a tool chip. Single-word core tools (Read, Edit, Bash)
 * read best Title-cased; capability names (`query_ontology`) are precise
 * identifiers a developer recognizes, so
 * they're kept verbatim.
 */
export function toolDisplayLabel(toolName: string): string {
  if (!toolName.includes(".") && !toolName.includes("_")) {
    return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
  return toolName;
}

/** True when a tool call is a subagent delegation (dispatch / spawn / task). */
export function isSubagentDispatch(toolName: string): boolean {
  return /subagent|dispatch|spawn/i.test(toolName);
}

/**
 * Pull the agent slug and task summary out of a subagent-dispatch input,
 * tolerating the several field names the fleet/engine use for each. Either may
 * be undefined when the input doesn't carry it.
 */
export function subagentInfo(input: unknown): { slug?: string; task?: string } {
  if (typeof input !== "object" || input === null) return {};
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
    return undefined;
  };
  return {
    slug: pick("agent", "agentType", "subagent", "slug", "type", "role"),
    task: pick("task", "prompt", "description", "goal", "objective", "title"),
  };
}

/** Cap a summary string so a tool line never wraps into a wall of text. */
const ARG_MAX = 80;

function cap(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > ARG_MAX ? t.slice(0, ARG_MAX) + "…" : t;
}

/**
 * Distil a tool's input into a short, human-readable summary — the bit shown
 * inside `tool(…)`. Never emits raw JSON: it picks the one field a human cares
 * about (the file path, the command, the query) and falls back to a compact
 * `key=value` / key list rather than dumping the argument object.
 *
 * Examples:
 *   ("Edit",  { file_path: "a.ts", old_string: "x", new_string: "y" }) → "a.ts"
 *   ("Bash",  { command: "git push origin main" })                     → "git push origin main"
 *   ("Grep",  { pattern: "TODO", path: "src" })                        → "TODO"
 *   ("mcp.x", { limit: 5, kind: "file" })                             → "kind=file, limit=5"
 */
export function formatToolArgs(toolName: string, input: unknown): string {
  const toolLower = toolName.toLowerCase();

  // Subagent delegation reads best as `slug → task`, so the transcript shows
  // who was dispatched and to do what — not the raw dispatch payload.
  if (
    isSubagentDispatch(toolName) &&
    typeof input === "object" &&
    input !== null
  ) {
    const { slug, task } = subagentInfo(input);
    const t = task ? cap(task) : "";
    if (slug && t) return `${slug} → ${t}`;
    if (slug) return slug;
    if (t) return t;
  }

  // Scalars: show as-is (capped).
  if (typeof input !== "object" || input === null) {
    return cap(String(input ?? ""));
  }
  const obj = input as Record<string, unknown>;

  // File operations — show the path.
  if (
    /(^|[.\-_])(read|write|edit|create|delete|view|open|cat)([.\-_]|$)/.test(
      toolLower,
    )
  ) {
    const path = obj.file_path ?? obj.path ?? obj.filename ?? obj.file;
    if (typeof path === "string") return cap(path);
  }

  // Shell/command execution — show the command.
  if (/(bash|shell|exec|command|run|terminal)/.test(toolLower)) {
    const cmd = obj.command ?? obj.cmd ?? obj.script ?? obj.args;
    if (typeof cmd === "string") return cap(cmd);
  }

  // Search/lookup — show the query/pattern.
  const query =
    obj.query ?? obj.pattern ?? obj.q ?? obj.search ?? obj.text ?? obj.prompt;
  if (typeof query === "string") return cap(query);

  // A lone path/name on any other tool is still the most useful summary.
  const path = obj.file_path ?? obj.path ?? obj.name ?? obj.id ?? obj.key;
  if (typeof path === "string") return cap(path);

  // Generic fallback: the first string value, else a compact key=value list of
  // scalar fields, else just the field names — never the raw JSON object.
  const entries = Object.entries(obj);
  const firstString = entries.find(([, v]) => typeof v === "string");
  if (firstString) return cap(firstString[1] as string);
  const scalars = entries
    .filter(([, v]) => typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v)}`);
  if (scalars.length) return cap(scalars.join(", "));
  return cap(entries.map(([k]) => k).join(", "));
}

/**
 * Format a tool call into a readable, human-friendly one-liner.
 *
 * Examples:
 *   ("Read", { file_path: "src/index.ts" })        → "📖 read(src/index.ts)"
 *   ("Edit", { file_path: "a.ts", old: "x" })       → "📝 edit(a.ts)"
 *   ("Bash", { command: "git push origin main" })   → "💻 bash(git push origin main)"
 */
export function formatToolCall(toolName: string, input: unknown): string {
  const emoji = getToolEmoji(toolName);
  const name = toolName.toLowerCase().replace(/\./g, "-");
  // Unmapped tools carry no emoji — omit the separator space too so the line
  // starts flush at the tool name.
  const prefix = emoji ? `${emoji} ` : "";
  return `${prefix}${name}(${formatToolArgs(toolName, input)})`;
}

/**
 * Format a tool call with leading/trailing spacing for readability.
 */
export function formatToolCallWithSpacing(
  toolName: string,
  input: unknown,
): string {
  return `\n  ${formatToolCall(toolName, input)}\n`;
}
