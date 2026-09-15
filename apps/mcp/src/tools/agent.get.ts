import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentGet.input.shape,
  agentId: agentGet.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
};

export const metadata: ToolMetadata = {
  name: agentGet.name,
  description: agentGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentGet.name, args, ctx, { surface: "mcp" });
  return agentGet.output.parse(output);
}
