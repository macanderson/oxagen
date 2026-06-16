import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTriggerDelete } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTriggerDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentTriggerDelete.name,
  description: agentTriggerDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentTriggerDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTriggerDelete.name, args, ctx, {
    surface: "mcp",
  });
  return agentTriggerDelete.output.parse(output);
}
