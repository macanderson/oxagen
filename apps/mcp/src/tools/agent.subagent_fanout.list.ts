import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentFanoutList } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSubagentFanoutList.input.shape,
  parentMessageId: agentSubagentFanoutList.input.shape.parentMessageId.describe(
    "Restrict results to fan-outs triggered by this message",
  ),
  limit: agentSubagentFanoutList.input.shape.limit.describe(
    "Maximum number of fan-outs to return, newest first",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentFanoutList.name,
  description: agentSubagentFanoutList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentFanoutListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentFanoutList.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentFanoutList.output.parse(output);
}
