import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryCitationsList } from "@oxagen/oxagen/contracts/agent.memory.citations.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryCitationsList.input.shape,
  executionId: agentMemoryCitationsList.input.shape.executionId.describe(
    "Execution id to list recorded memory citations for",
  ),
  compliance: agentMemoryCitationsList.input.shape.compliance.describe(
    "Filter to a single compliance outcome (e.g. VIOLATION)",
  ),
  influenceIn: agentMemoryCitationsList.input.shape.influenceIn.describe(
    "Filter to these influence levels (e.g. [DECISIVE, CONTRIBUTING])",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryCitationsList.name,
  description: agentMemoryCitationsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryCitationsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryCitationsList.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryCitationsList.output.parse(output);
}
