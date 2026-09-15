import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentApprovalList.input.shape,
  runId: agentApprovalList.input.shape.runId.describe(
    "Only approvals recorded on this run (a run public id)",
  ),
  limit: agentApprovalList.input.shape.limit.describe(
    "Page size, 1 to 100; default 50",
  ),
  cursor: agentApprovalList.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
};

export const metadata: ToolMetadata = {
  name: agentApprovalList.name,
  description: agentApprovalList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentApprovalListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentApprovalList.name, args, ctx, {
    surface: "mcp",
  });
  return agentApprovalList.output.parse(output);
}
