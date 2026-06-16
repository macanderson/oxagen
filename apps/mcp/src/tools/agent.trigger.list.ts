import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTriggerList } from "@oxagen/oxagen/contracts/agent.trigger.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTriggerList.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentTriggerList.name,
  description: agentTriggerList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentTriggerListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTriggerList.name, args, ctx, {
    surface: "mcp",
  });
  return agentTriggerList.output.parse(output);
}
