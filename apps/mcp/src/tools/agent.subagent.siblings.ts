import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentSiblings } from "@oxagen/oxagen/contracts/agent.subagent.siblings";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: agentSubagentSiblings.input.shape.runId.describe(
    "Public ID of the calling child run (sar_…) whose fanout siblings to list",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentSiblings.name,
  description: agentSubagentSiblings.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentSiblingsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentSiblings.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentSiblings.output.parse(output);
}
