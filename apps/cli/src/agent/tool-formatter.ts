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
  "semantic.edge.suggest": "🧠",
  "semantic.relationship.approve": "✅",
  "knowledge.query": "🔍",

  // LLM & inference
  "agent.code.execute": "⚡",
  "agent.subagent.dispatch": "🚀",

  // Workflow & process
  "workflow.run": "▶️",
  "workflow.cancel": "⏹️",

  // Default
  default: "🔧",
};

/**
 * Get emoji for a tool name.
 */
export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] ?? "🔧";
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

  // Scalars: show as-is (capped).
  if (typeof input !== "object" || input === null) {
    return cap(String(input ?? ""));
  }
  const obj = input as Record<string, unknown>;

  // File operations — show the path.
  if (/(^|[.\-_])(read|write|edit|create|delete|view|open|cat)([.\-_]|$)/.test(toolLower)) {
    const path = obj.file_path ?? obj.path ?? obj.filename ?? obj.file;
    if (typeof path === "string") return cap(path);
  }

  // Shell/command execution — show the command.
  if (/(bash|shell|exec|command|run|terminal)/.test(toolLower)) {
    const cmd = obj.command ?? obj.cmd ?? obj.script ?? obj.args;
    if (typeof cmd === "string") return cap(cmd);
  }

  // Search/lookup — show the query/pattern.
  const query = obj.query ?? obj.pattern ?? obj.q ?? obj.search ?? obj.text ?? obj.prompt;
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
  return `${emoji} ${name}(${formatToolArgs(toolName, input)})`;
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
