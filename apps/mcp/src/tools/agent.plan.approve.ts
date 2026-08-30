import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentPlanApprove.input.shape,
  planId: agentPlanApprove.input.shape.planId.describe(
    "ID of the plan to approve, deny, or amend",
  ),
  decision: agentPlanApprove.input.shape.decision.describe(
    "Decision for the proposed plan",
  ),
  amendedSteps: agentPlanApprove.input.shape.amendedSteps.describe(
    "Replacement step list when decision is 'amend'",
  ),
  note: agentPlanApprove.input.shape.note.describe(
    "Optional note explaining the decision",
  ),
};

export const metadata: ToolMetadata = {
  name: agentPlanApprove.name,
  description: agentPlanApprove.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentPlanApproveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentPlanApprove.name, args, ctx, {
    surface: "mcp",
  });
  return agentPlanApprove.output.parse(output);
}
