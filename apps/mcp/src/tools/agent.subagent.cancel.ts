import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentCancel } from "@oxagen/oxagen/contracts/agent.subagent.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSubagentCancel.input.shape,
  fanoutId: agentSubagentCancel.input.shape.fanoutId.describe(
    "Public ID of the fan-out to cancel",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentCancel.name,
  description: agentSubagentCancel.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentCancelTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentCancel.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentCancel.output.parse(output);
}
