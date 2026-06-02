import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  approvalId: z.string().describe("ID of the pending approval request to resolve"),
  decision: z.enum(["approved", "denied"]).describe("Resolution decision for the approval request"),
  note: z.string().optional().describe("Optional note explaining the decision"),
};

export const metadata: ToolMetadata = {
  name: agentApprovalResolve.name,
  description: agentApprovalResolve.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentApprovalResolveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentApprovalResolve.name, args, ctx, { surface: "mcp" });
  return agentApprovalResolve.output.parse(output);
}
