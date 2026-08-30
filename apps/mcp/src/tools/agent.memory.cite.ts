import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryCite } from "@oxagen/oxagen/contracts/agent.memory.cite";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryCite.input.shape,
  executionRef: agentMemoryCite.input.shape.executionRef.describe(
    "Execution id to attach citations to; created (MERGE) if absent",
  ),
  citations: agentMemoryCite.input.shape.citations.describe(
    "Memories cited during this execution, with influence and rule-deviation info",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryCite.name,
  description: agentMemoryCite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryCiteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryCite.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryCite.output.parse(output);
}
