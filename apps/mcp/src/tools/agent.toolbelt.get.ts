import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentToolbeltGet.input.shape,
  agentId: agentToolbeltGet.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  mode: agentToolbeltGet.input.shape.mode.describe(
    "Force full or searchable presentation; omitted, the belt size against the limit decides",
  ),
};

export const metadata: ToolMetadata = {
  name: agentToolbeltGet.name,
  description: agentToolbeltGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentToolbeltGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentToolbeltGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentToolbeltGet.output.parse(output);
}
