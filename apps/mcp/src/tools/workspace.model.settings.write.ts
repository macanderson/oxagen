import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceModelSettingsWrite } from "@oxagen/oxagen/contracts/workspace.model.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  defaultTextTier: z
    .enum(["fast", "balanced", "precise"])
    .nullable()
    .optional()
    .describe("Workspace text model tier override (null clears the override)"),
  defaultTextModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit workspace text model id (null clears)"),
  defaultImageModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit workspace image model id (null clears)"),
  defaultVideoModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit workspace video model id (null clears)"),
};

export const metadata: ToolMetadata = {
  name: workspaceModelSettingsWrite.name,
  description: workspaceModelSettingsWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceModelSettingsWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceModelSettingsWrite.name, args, ctx, { surface: "mcp" });
  return workspaceModelSettingsWrite.output.parse(output);
}
