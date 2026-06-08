import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceMemberList } from "@oxagen/oxagen/contracts/workspace.member.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  workspace_id: z
    .string()
    .optional()
    .describe("Workspace ID (defaults to the current workspace from context)"),
};

export const metadata: ToolMetadata = {
  name: workspaceMemberList.name,
  description: workspaceMemberList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceMemberListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceMemberList.name, args, ctx, { surface: "mcp" });
  return workspaceMemberList.output.parse(output);
}
