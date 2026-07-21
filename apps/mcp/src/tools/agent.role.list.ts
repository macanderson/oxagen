import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRoleList } from "@oxagen/oxagen/contracts/agent.role.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRoleList.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentRoleList.name,
  description: agentRoleList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentRoleListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRoleList.name, args, ctx, {
    surface: "mcp",
  });
  return agentRoleList.output.parse(output);
}
