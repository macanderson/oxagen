import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillMetricsRead } from "@oxagen/oxagen/contracts/skill.metrics.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skillId: skillMetricsRead.input.shape.skillId.describe(
    "Public ID of a specific skill (e.g. 'skl_…'). Omit to return workspace-wide aggregates.",
  ),
};

export const metadata: ToolMetadata = {
  name: skillMetricsRead.name,
  description: skillMetricsRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillMetricsReadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillMetricsRead.name, args, ctx, {
    surface: "mcp",
  });
  return skillMetricsRead.output.parse(output);
}
