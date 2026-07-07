import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionSuggest.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionSuggest.name,
  description: agentDefinitionSuggest.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionSuggestTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionSuggest.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionSuggest.output.parse(output);
}
