import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionDelete } from "@oxagen/oxagen/contracts/agent.definition.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionDelete.name,
  description: agentDefinitionDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentDefinitionDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionDelete.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionDelete.output.parse(output);
}
