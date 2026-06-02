import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  planId: z.string().describe("ID of the plan to approve, deny, or amend"),
  decision: z.enum(["approve", "deny", "amend"]).describe("Decision for the proposed plan"),
  amendedSteps: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string(),
        intent: z.string(),
        capability: z.string().nullable(),
        inputPreview: z.unknown().nullable(),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .optional()
    .describe("Replacement step list when decision is 'amend'"),
  note: z.string().optional().describe("Optional note explaining the decision"),
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
  const output = await invoke(agentPlanApprove.name, args, ctx, { surface: "mcp" });
  return agentPlanApprove.output.parse(output);
}
