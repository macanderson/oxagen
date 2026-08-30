import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentExecutionRecord } from "@oxagen/oxagen/contracts/agent.execution.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentExecutionRecord.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentExecutionRecord.name,
  description: agentExecutionRecord.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentExecutionRecordTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentExecutionRecord.name, args, ctx, {
    surface: "mcp",
  });
  return agentExecutionRecord.output.parse(output);
}
