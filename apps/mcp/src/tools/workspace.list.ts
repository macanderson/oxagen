import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceList.input.shape,
  orgSlug: workspaceList.input.shape.orgSlug.describe(
    "Slug of the organization whose workspaces to list",
  ),
};

export const metadata: ToolMetadata = {
  name: workspaceList.name,
  description: workspaceList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceList.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceList.output.parse(output);
}
