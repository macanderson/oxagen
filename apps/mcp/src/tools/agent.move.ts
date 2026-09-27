import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMove } from "@oxagen/oxagen/contracts/agent.move";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  agentId: agentMove.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  runtimeId: agentMove.input.shape.runtimeId.describe(
    "The runtime to move it to (rtm_…), from list_runtimes",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMove.name,
  description: agentMove.description,
  annotations: {
    readOnlyHint: false,
    // The move revokes the agent's live host enrollments on the old runtime.
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentMoveTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMove.name, args, ctx, {
    surface: "mcp",
  });
  return agentMove.output.parse(output);
}
