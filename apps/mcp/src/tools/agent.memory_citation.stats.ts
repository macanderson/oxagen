import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryCitationStats } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryCitationStats.input.shape,
  days: agentMemoryCitationStats.input.shape.days.describe(
    "Window in days for the daily series and totals",
  ),
  limit: agentMemoryCitationStats.input.shape.limit.describe(
    "Max entries per top-N list",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryCitationStats.name,
  description: agentMemoryCitationStats.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryCitationStatsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryCitationStats.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryCitationStats.output.parse(output);
}
