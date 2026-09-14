import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSuspend.input.shape,
  agentId: agentSuspend.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  suspended: agentSuspend.input.shape.suspended.describe(
    "true suspends; false resumes a suspended agent",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSuspend.name,
  description: agentSuspend.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSuspendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSuspend.name, args, ctx, {
    surface: "mcp",
  });
  return agentSuspend.output.parse(output);
}
