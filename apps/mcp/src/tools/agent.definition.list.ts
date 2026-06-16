import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionList } from "@oxagen/oxagen/contracts/agent.definition.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionList.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionList.name,
  description: agentDefinitionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentDefinitionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionList.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionList.output.parse(output);
}
