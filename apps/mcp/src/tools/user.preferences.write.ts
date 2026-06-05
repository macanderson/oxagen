import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesWrite } from "@oxagen/oxagen/contracts/user.preferences.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  fontSize: z
    .enum(["small", "medium", "large"])
    .optional()
    .describe("UI text size preference"),
  density: z
    .enum(["compact", "comfortable", "spacious"])
    .optional()
    .describe("UI density preference"),
  enterToSubmit: z
    .boolean()
    .optional()
    .describe("When true, Enter submits; otherwise Enter inserts a newline"),
  pendingPromptBehavior: z
    .enum(["queue", "interrupt"])
    .optional()
    .describe("What to do with a new prompt while a response is in flight"),
  defaultTextTier: z
    .enum(["fast", "balanced", "precise"])
    .nullable()
    .optional()
    .describe("Preferred text model tier (null clears the preference)"),
  defaultTextModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit text model id, e.g. 'anthropic/claude-opus-4.8' (null clears)"),
  defaultImageModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit image model id, e.g. 'bfl/flux-2-max' (null clears)"),
  defaultVideoModel: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Explicit video model id, e.g. 'google/veo-3.0-generate-001' (null clears)"),
};

export const metadata: ToolMetadata = {
  name: userPreferencesWrite.name,
  description: userPreferencesWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userPreferencesWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesWrite.name, args, ctx, { surface: "mcp" });
  return userPreferencesWrite.output.parse(output);
}
