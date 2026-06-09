import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { connectionDelete } from "@oxagen/oxagen/contracts/connection.delete";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";
import { connectionMappingsSuggest } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// ── connection.list ──────────────────────────────────────────────────────────

export const connectionListSchema = {
  ...connectionList.input.shape,
};

export const connectionListMetadata: ToolMetadata = {
  name: connectionList.name,
  description: connectionList.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export async function connectionListTool(args: InferSchema<typeof connectionListSchema>) {
  const ctx = await buildContext(headers());
  return invoke(connectionList.name, args, ctx, { surface: "mcp" });
}

// ── connection.create ────────────────────────────────────────────────────────

export const connectionCreateSchema = {
  ...connectionCreate.input.shape,
};

export const connectionCreateMetadata: ToolMetadata = {
  name: connectionCreate.name,
  description: connectionCreate.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export async function connectionCreateTool(args: InferSchema<typeof connectionCreateSchema>) {
  const ctx = await buildContext(headers());
  return invoke(connectionCreate.name, args, ctx, { surface: "mcp" });
}

// ── connection.get ───────────────────────────────────────────────────────────

export const connectionGetSchema = {
  ...connectionGet.input.shape,
};

export const connectionGetMetadata: ToolMetadata = {
  name: connectionGet.name,
  description: connectionGet.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export async function connectionGetTool(args: InferSchema<typeof connectionGetSchema>) {
  const ctx = await buildContext(headers());
  return invoke(connectionGet.name, args, ctx, { surface: "mcp" });
}

// ── connection.delete ────────────────────────────────────────────────────────

export const connectionDeleteSchema = {
  ...connectionDelete.input.shape,
};

export const connectionDeleteMetadata: ToolMetadata = {
  name: connectionDelete.name,
  description: connectionDelete.description,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export async function connectionDeleteTool(args: InferSchema<typeof connectionDeleteSchema>) {
  const ctx = await buildContext(headers());
  return invoke(connectionDelete.name, args, ctx, { surface: "mcp" });
}

// ── connection.preview ───────────────────────────────────────────────────────

export const connectionPreviewSchema = {
  ...connectionPreview.input.shape,
};

export const connectionPreviewMetadata: ToolMetadata = {
  name: connectionPreview.name,
  description: connectionPreview.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export async function connectionPreviewTool(args: InferSchema<typeof connectionPreviewSchema>) {
  const ctx = await buildContext(headers());
  return invoke(connectionPreview.name, args, ctx, { surface: "mcp" });
}

// ── connection.mappings.suggest ───────────────────────────────────────────────

export const connectionMappingsSuggestSchema = {
  ...connectionMappingsSuggest.input.shape,
};

export const connectionMappingsSuggestMetadata: ToolMetadata = {
  name: connectionMappingsSuggest.name,
  description: connectionMappingsSuggest.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export async function connectionMappingsSuggestTool(
  args: InferSchema<typeof connectionMappingsSuggestSchema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsSuggest.name, args, ctx, { surface: "mcp" });
}

// ── connection.mappings.get ───────────────────────────────────────────────────

export const connectionMappingsGetSchema = {
  ...connectionMappingsGet.input.shape,
};

export const connectionMappingsGetMetadata: ToolMetadata = {
  name: connectionMappingsGet.name,
  description: connectionMappingsGet.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export async function connectionMappingsGetTool(
  args: InferSchema<typeof connectionMappingsGetSchema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsGet.name, args, ctx, { surface: "mcp" });
}

// ── connection.mappings.set ───────────────────────────────────────────────────

export const connectionMappingsSetSchema = {
  ...connectionMappingsSet.input.shape,
};

export const connectionMappingsSetMetadata: ToolMetadata = {
  name: connectionMappingsSet.name,
  description: connectionMappingsSet.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export async function connectionMappingsSetTool(
  args: InferSchema<typeof connectionMappingsSetSchema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsSet.name, args, ctx, { surface: "mcp" });
}
