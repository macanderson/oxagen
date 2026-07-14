import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentPlanList } from "@oxagen/oxagen/contracts/agent.plan.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentPlanList.input.shape,
  status: agentPlanList.input.shape.status.describe(
    "Filter to plans in this status (draft, awaiting_approval, approved, denied, amended)",
  ),
  limit: agentPlanList.input.shape.limit.describe(
    "Max plans to return (1–100, default 20)",
  ),
  cursor: agentPlanList.input.shape.cursor.describe(
    "Pass the previous page's nextCursor to page through older plans",
  ),
};

export const metadata: ToolMetadata = {
  name: agentPlanList.name,
  description: agentPlanList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentPlanListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentPlanList.name, args, ctx, {
    surface: "mcp",
  });
  return agentPlanList.output.parse(output);
}
