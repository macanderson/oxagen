// tool-result.ts — the result every tool in src/tools/ answers with (#5463).
//
// xmcp 0.6.13 wraps a returned object as `structuredContent` only when the
// tool's metadata declares an `outputSchema`. No tool here declares one, so a
// plain object reached the client as "Tool handler must return at least
// 'content' or 'structuredContent'" on every call. Each tool's default export
// returns through toolResult(), and tools.result-shape.test.ts fails on one
// that does not.
import type { CallToolResult } from "@oxagen/mcp-studio";

/** A JSON object: what MCP allows in `structuredContent`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A tool's output as an MCP `tools/call` result: the output as JSON text in
 * `content`, for clients that read text, and the same output as
 * `structuredContent` when it is an object. MCP allows only an object there,
 * so an array, a string, or null travels as text alone.
 */
export function toolResult(output: unknown): CallToolResult {
  // JSON.stringify(undefined) is undefined, and xmcp refuses a text item
  // whose text is not a string.
  const text = JSON.stringify(output ?? null, null, 2);
  const content = [{ type: "text", text }];
  return isJsonObject(output)
    ? { content, structuredContent: output }
    : { content };
}
