import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRetire.input.shape,
  agentId: agentRetire.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
};

export const metadata: ToolMetadata = {
  name: agentRetire.name,
  description: agentRetire.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentRetireTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRetire.name, args, ctx, { surface: "mcp" });
  return agentRetire.output.parse(output);
}
