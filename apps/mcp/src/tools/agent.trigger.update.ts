import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTriggerUpdate } from "@oxagen/oxagen/contracts/agent.trigger.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTriggerUpdate.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentTriggerUpdate.name,
  description: agentTriggerUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentTriggerUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTriggerUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return agentTriggerUpdate.output.parse(output);
}
