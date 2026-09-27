// from-mcp.ts: an MCP server's tools/list entry as an UpstreamTool.
//
// MCP needs no importer lane: a tools/list entry already has a name, a
// description, and input and output schemas. This mapping is part of the
// model, so the lock, compile, and the fixtures agree on it.
import type { LockedMcpTool, McpTool } from "../contract/mcp-tool";
import { lockedMcpTool } from "../contract/mcp-tool";
import { cutDescription, type UpstreamTool, type UpstreamToolOf } from "./upstream-tool";

/**
 * One tools/list entry as the operation model holds it. `_meta` and unknown
 * fields stay out, and a description past 1,024 characters is cut, so a
 * verbose server's text adds at most 1,024 characters per tool to the lock.
 */
export function upstreamFromMcpTool(tool: McpTool): UpstreamToolOf<"mcp"> {
  const { name, title, description, inputSchema, outputSchema, annotations } = lockedMcpTool(tool);
  const upstream: UpstreamToolOf<"mcp"> = {
    name,
    inputSchema,
    request: { kind: "mcp", tool: name },
  };
  if (title !== undefined) upstream.title = title;
  if (description !== undefined) upstream.description = cutDescription(description);
  if (outputSchema !== undefined) upstream.outputSchema = outputSchema;
  if (annotations !== undefined) upstream.annotations = annotations;
  return upstream;
}

/**
 * What a lock pins for a tool: an MCP tool's tools/list entry, or the whole
 * UpstreamTool for a server built from a definition. An MCP entry keeps no
 * request template, because the template is only the tool's own name.
 */
export function lockedUpstream(tool: UpstreamTool): LockedMcpTool | UpstreamTool {
  if (tool.request.kind !== "mcp") return tool;
  const locked: LockedMcpTool = { name: tool.request.tool, inputSchema: tool.inputSchema };
  if (tool.title !== undefined) locked.title = tool.title;
  if (tool.description !== undefined) locked.description = tool.description;
  if (tool.outputSchema !== undefined) locked.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) locked.annotations = tool.annotations;
  return locked;
}
