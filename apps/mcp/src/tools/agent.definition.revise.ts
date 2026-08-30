import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionRevise } from "@oxagen/oxagen/contracts/agent.definition.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  agentId: agentDefinitionRevise.input.shape.agentId.describe(
    "Agent public id (agt_…), UUID, or slug of the agent to revise.",
  ),
  prompt: agentDefinitionRevise.input.shape.prompt.describe(
    "Plain-language description of the change to make (10–4000 characters), e.g. 'give it read access to the billing ontology and equip the github MCP server'.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentDefinitionRevise.name,
  description: agentDefinitionRevise.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionReviseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionRevise.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionRevise.output.parse(output);
}
