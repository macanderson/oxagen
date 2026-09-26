// mcp-tool.ts: an MCP tool as a server's tools/list returns it, and the part
// of it a lock file pins (mcp-studio-spec, Lock file).
//
// A server may add fields MCP defines later, so the tools/list shapes pass
// unknown keys through. The locked form keeps only the fields the model
// reads, so a new field the server adds cannot change the lock.
import { z } from "zod";
import { jsonObjectSchema, objectJsonSchemaSchema } from "./primitives";

/** The hints MCP lets a server attach to a tool. Oxagen never sends these to an agent. */
export const mcpToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();
export type McpToolAnnotations = z.output<typeof mcpToolAnnotationsSchema>;

/** The hints a lock pins: the five MCP defines, so a hint a server adds later cannot change the lock. */
export const lockedMcpToolAnnotationsSchema = mcpToolAnnotationsSchema.strict();
export type LockedMcpToolAnnotations = z.output<typeof lockedMcpToolAnnotationsSchema>;

const ANNOTATION_KEYS = ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** One entry of a tools/list result, as the server sent it. */
export const mcpToolSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: objectJsonSchemaSchema,
    outputSchema: objectJsonSchemaSchema.optional(),
    annotations: mcpToolAnnotationsSchema.optional(),
    _meta: jsonObjectSchema.optional(),
  })
  .passthrough();
export type McpTool = z.output<typeof mcpToolSchema>;

/** The result of one tools/list call. */
export const mcpToolsListResultSchema = z
  .object({
    tools: z.array(mcpToolSchema),
    nextCursor: z.string().optional(),
  })
  .passthrough();
export type McpToolsListResult = z.output<typeof mcpToolsListResultSchema>;

/** An MCP tool as a lock file pins it: the fields the model reads, and no others. */
export const lockedMcpToolSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: objectJsonSchemaSchema,
    outputSchema: objectJsonSchemaSchema.optional(),
    annotations: lockedMcpToolAnnotationsSchema.optional(),
  })
  .strict();
export type LockedMcpTool = z.output<typeof lockedMcpToolSchema>;

/** The part of a tools/list entry a lock pins. `_meta`, fields MCP adds later, and unknown hints stay out. */
export function lockedMcpTool(tool: McpTool): LockedMcpTool {
  const locked: LockedMcpTool = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.title !== undefined) locked.title = tool.title;
  if (tool.description !== undefined) locked.description = tool.description;
  if (tool.outputSchema !== undefined) locked.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) {
    const annotations: Record<string, unknown> = {};
    for (const key of ANNOTATION_KEYS) {
      if (tool.annotations[key] !== undefined) annotations[key] = tool.annotations[key];
    }
    locked.annotations = annotations as LockedMcpToolAnnotations;
  }
  return locked;
}
