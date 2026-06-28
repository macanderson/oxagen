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

/**
 * Format a tool call into a readable, human-friendly output.
 *
 * Examples:
 *   input: { toolName: "Read", input: { file_path: "src/index.ts" } }
 *   output: "📖 read(src/index.ts)"
 *
 *   input: { toolName: "Edit", input: { file_path: "a.ts", old: "x", new: "y" } }
 *   output: "📝 edit(a.ts)"
 *
 *   input: { toolName: "Bash", input: { command: "git push origin main" } }
 *   output: "💻 bash(git push origin main)"
 */
export function formatToolCall(toolName: string, input: unknown): string {
  const emoji = getToolEmoji(toolName);
  const toolLower = toolName.toLowerCase().replace(".", "-");

  // Parse common tool input patterns
  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;

    // Read, Write, Edit, Delete, Create — file operations
    if (["read", "write", "edit", "delete", "create"].includes(toolLower)) {
      const path = obj.file_path ?? obj.path ?? "";
      return `${emoji} ${toolLower}(${path})`;
    }

    // Bash — command execution
    if (toolLower === "bash") {
      const cmd = obj.command ?? String(input).slice(0, 50);
      return `${emoji} bash(${cmd})`;
    }

    // Generic: show first meaningful property
    const firstKey = Object.keys(obj)[0];
    const firstVal = firstKey ? obj[firstKey] : input;
    const summary =
      typeof firstVal === "string"
        ? firstVal.slice(0, 60)
        : JSON.stringify(firstVal).slice(0, 60);
    return `${emoji} ${toolLower}(${summary})`;
  }

  // String or scalar input
  const summary = String(input).slice(0, 60);
  return `${emoji} ${toolLower}(${summary})`;
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
