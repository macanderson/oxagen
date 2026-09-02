import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentExecutionList } from "@oxagen/oxagen/contracts/agent.execution.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentExecutionList.input.shape,
  limit: agentExecutionList.input.shape.limit.describe(
    "Max runs to return (1–100)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentExecutionList.name,
  description: agentExecutionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentExecutionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentExecutionList.name, args, ctx, {
    surface: "mcp",
  });
  return agentExecutionList.output.parse(output);
}
