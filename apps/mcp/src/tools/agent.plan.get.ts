import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentPlanGet } from "@oxagen/oxagen/contracts/agent.plan.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentPlanGet.input.shape,
  planId: agentPlanGet.input.shape.planId.describe(
    "The plan's public id (apl_…)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentPlanGet.name,
  description: agentPlanGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentPlanGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentPlanGet.name, args, ctx, { surface: "mcp" });
  return agentPlanGet.output.parse(output);
}
