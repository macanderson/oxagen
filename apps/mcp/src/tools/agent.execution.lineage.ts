import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentExecutionLineage } from "@oxagen/oxagen/contracts/agent.execution.lineage";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentExecutionLineage.input.shape,
  executionId: agentExecutionLineage.input.shape.executionId.describe(
    "Public ID or UUID of the :Execution graph node whose file-level lineage to fetch",
  ),
};

export const metadata: ToolMetadata = {
  name: agentExecutionLineage.name,
  description: agentExecutionLineage.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentExecutionLineageTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentExecutionLineage.name, args, ctx, { surface: "mcp" });
  return agentExecutionLineage.output.parse(output);
}
