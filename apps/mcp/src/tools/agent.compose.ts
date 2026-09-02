import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentCompose } from "@oxagen/oxagen/contracts/agent.compose";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentCompose.input.shape,
  goal: agentCompose.input.shape.goal.describe(
    "What to accomplish. The planner composes a chain of capabilities to achieve it.",
  ),
  maxSteps: agentCompose.input.shape.maxSteps.describe(
    "Maximum number of steps the planner may produce (1–10, default 6).",
  ),
  autoExecute: agentCompose.input.shape.autoExecute.describe(
    "When false, returns the plan without executing it (dry run).",
  ),
  context: agentCompose.input.shape.context.describe(
    "Optional extra context or constraints for the planner.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentCompose.name,
  description: agentCompose.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentComposeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentCompose.name, args, ctx, { surface: "mcp" });
  return agentCompose.output.parse(output);
}
