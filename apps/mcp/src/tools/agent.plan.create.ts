import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentPlanCreate } from "@oxagen/oxagen/contracts/agent.plan.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentPlanCreate.input.shape,
  goals: agentPlanCreate.input.shape.goals.describe(
    "High-level goals this plan achieves (1–20 items)",
  ),
  constraints: agentPlanCreate.input.shape.constraints.describe(
    "Hard constraints the plan must respect",
  ),
  tasks: agentPlanCreate.input.shape.tasks.describe(
    "Ordered task list with optional parent and dependency references (max 100)",
  ),
  approvalRequired: agentPlanCreate.input.shape.approvalRequired.describe(
    "Require user approval before any task executes",
  ),
  messageId: agentPlanCreate.input.shape.messageId.describe(
    "Originating conversation message ID",
  ),
};

export const metadata: ToolMetadata = {
  name: agentPlanCreate.name,
  description: agentPlanCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentPlanCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentPlanCreate.name, args, ctx, {
    surface: "mcp",
  });
  return agentPlanCreate.output.parse(output);
}
