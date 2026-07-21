import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRoleRevoke.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentRoleRevoke.name,
  description: agentRoleRevoke.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentRoleRevokeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRoleRevoke.name, args, ctx, {
    surface: "mcp",
  });
  return agentRoleRevoke.output.parse(output);
}
