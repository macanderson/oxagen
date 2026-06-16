import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionGet } from "@oxagen/oxagen/contracts/agent.definition.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionGet.name,
  description: agentDefinitionGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentDefinitionGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionGet.output.parse(output);
}
