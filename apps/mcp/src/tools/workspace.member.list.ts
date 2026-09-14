import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceMemberList } from "@oxagen/oxagen/contracts/workspace.member.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceMemberList.input.shape,
  workspace_id: workspaceMemberList.input.shape.workspace_id.describe(
    "Ignored on this surface. Members are always listed for the workspace the " +
      "calling API key is scoped to; the handler reads scope from the request " +
      "context, never from this field.",
  ),
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
  const output = await invoke(workspaceMemberList.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceMemberList.output.parse(output);
}
