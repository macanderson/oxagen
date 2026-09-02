import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentEnvironmentUnbind } from "@oxagen/oxagen/contracts/agent.environment.unbind";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentEnvironmentUnbind.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentEnvironmentUnbind.name,
  description: agentEnvironmentUnbind.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentEnvironmentUnbindTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentEnvironmentUnbind.name, args, ctx, {
    surface: "mcp",
  });
  return agentEnvironmentUnbind.output.parse(output);
}
