import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceArchive.input.shape,
  workspaceId: workspaceArchive.input.shape.workspaceId.describe(
    "The workspace's public id (wrk_…), from list_workspaces",
  ),
};

export const metadata: ToolMetadata = {
  name: workspaceArchive.name,
  description: workspaceArchive.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function archiveWorkspaceTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceArchive.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceArchive.output.parse(output);
}
