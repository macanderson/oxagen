import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionPublish } from "@oxagen/oxagen/contracts/agent.definition.publish";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionPublish.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDefinitionPublish.name,
  description: agentDefinitionPublish.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionPublishTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionPublish.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionPublish.output.parse(output);
}
