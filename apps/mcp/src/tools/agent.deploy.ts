import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDeploy } from "@oxagen/oxagen/contracts/agent.deploy";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDeploy.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentDeploy.name,
  description: agentDeploy.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentDeployTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDeploy.name, args, ctx, { surface: "mcp" });
  return agentDeploy.output.parse(output);
}
