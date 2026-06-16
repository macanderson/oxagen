import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionCreate } from "@oxagen/oxagen/contracts/agent.definition.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionCreate.name,
  description: agentDefinitionCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionCreate.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionCreate.output.parse(output);
}
