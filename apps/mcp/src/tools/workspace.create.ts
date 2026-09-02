import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceCreate.input.shape,
  name: workspaceCreate.input.shape.name.describe(
    "Display name for the workspace",
  ),
  slug: workspaceCreate.input.shape.slug.describe(
    "URL-safe unique slug within the organization",
  ),
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
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceCreate.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceCreate.output.parse(output);
}
