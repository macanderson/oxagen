import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionSummarize.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionSummarize.name,
  description: agentDefinitionSummarize.description,
  annotations: {
    // Writes a derived summary field (not read-only), but is non-destructive and
    // cached: without `force` a re-run returns the existing summary unchanged.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionSummarizeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionSummarize.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionSummarize.output.parse(output);
}
