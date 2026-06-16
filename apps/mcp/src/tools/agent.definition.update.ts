import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionUpdate } from "@oxagen/oxagen/contracts/agent.definition.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionUpdate.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionUpdate.name,
  description: agentDefinitionUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionUpdate.output.parse(output);
}
