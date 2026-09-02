import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentResultGet } from "@oxagen/oxagen/contracts/agent.subagent_result.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: agentSubagentResultGet.input.shape.runId.describe(
    "Public ID of the child run to fetch (from aggregate_subagents children[].runId / timeline[].runId)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentResultGet.name,
  description: agentSubagentResultGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentResultGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentResultGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentResultGet.output.parse(output);
}
