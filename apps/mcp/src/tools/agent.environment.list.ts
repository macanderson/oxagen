import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentEnvironmentList } from "@oxagen/oxagen/contracts/agent.environment.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentEnvironmentList.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentEnvironmentList.name,
  description: agentEnvironmentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentEnvironmentListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentEnvironmentList.name, args, ctx, {
    surface: "mcp",
  });
  return agentEnvironmentList.output.parse(output);
}
