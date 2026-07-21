import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRoleGet } from "@oxagen/oxagen/contracts/agent.role.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRoleGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentRoleGet.name,
  description: agentRoleGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentRoleGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRoleGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentRoleGet.output.parse(output);
}
