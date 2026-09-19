import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentApprovalListResolved.input.shape,
  runId: agentApprovalListResolved.input.shape.runId.describe(
    "Only approvals recorded on this run (a run public id)",
  ),
  since: agentApprovalListResolved.input.shape.since.describe(
    "Only rows resolved at or after this instant",
  ),
  until: agentApprovalListResolved.input.shape.until.describe(
    "Only rows resolved at or before this instant",
  ),
  limit: agentApprovalListResolved.input.shape.limit.describe(
    "Page size, 1 to 100; default 50",
  ),
  cursor: agentApprovalListResolved.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
};

export const metadata: ToolMetadata = {
  name: agentApprovalListResolved.name,
  description: agentApprovalListResolved.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentApprovalListResolvedTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentApprovalListResolved.name, args, ctx, {
    surface: "mcp",
  });
  return agentApprovalListResolved.output.parse(output);
}
