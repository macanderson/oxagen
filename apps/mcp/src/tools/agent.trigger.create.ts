import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTriggerCreate } from "@oxagen/oxagen/contracts/agent.trigger.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTriggerCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentTriggerCreate.name,
  description: agentTriggerCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentTriggerCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTriggerCreate.name, args, ctx, {
    surface: "mcp",
  });
  return agentTriggerCreate.output.parse(output);
}
