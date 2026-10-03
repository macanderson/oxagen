import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentEnvironmentBind } from "@oxagen/oxagen/contracts/agent.environment.bind";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...agentEnvironmentBind.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentEnvironmentBind.name,
  description: agentEnvironmentBind.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentEnvironmentBindTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentEnvironmentBind.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(agentEnvironmentBind.output.parse(output));
}
