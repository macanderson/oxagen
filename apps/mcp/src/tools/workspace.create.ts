import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { workspaceCreateHandler } from "@oxagen/handlers/workspace.create";
import { buildContext } from "../context.js";

export const schema = {
  name: z.string().min(1).max(120).describe("Display name for the workspace"),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only")
    .describe("URL-safe unique slug within the organization"),
};

export const metadata: ToolMetadata = {
  name: workspaceCreate.name,
  description: workspaceCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function workspaceCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = buildContext(headers());
  const output = await workspaceCreateHandler(args, ctx);
  return workspaceCreate.output.parse(output);
}
