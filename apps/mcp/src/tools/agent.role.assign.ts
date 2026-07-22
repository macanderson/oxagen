import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRoleAssign.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentRoleAssign.name,
  description: agentRoleAssign.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentRoleAssignTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRoleAssign.name, args, ctx, {
    surface: "mcp",
  });
  return agentRoleAssign.output.parse(output);
}
