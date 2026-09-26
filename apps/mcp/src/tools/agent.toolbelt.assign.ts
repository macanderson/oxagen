import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentToolbeltAssign } from "@oxagen/oxagen/contracts/agent.toolbelt.assign";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  agentId: agentToolbeltAssign.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  toolbeltId: agentToolbeltAssign.input.shape.toolbeltId.describe(
    "The toolbelt to give it (tbt_…), from list_toolbelts",
  ),
};

export const metadata: ToolMetadata = {
  name: agentToolbeltAssign.name,
  description: agentToolbeltAssign.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentToolbeltAssignTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentToolbeltAssign.name, args, ctx, {
    surface: "mcp",
  });
  return agentToolbeltAssign.output.parse(output);
}
