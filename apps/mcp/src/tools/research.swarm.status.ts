import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...researchSwarmStatus.input.shape,
  swarmId: researchSwarmStatus.input.shape.swarmId.describe(
    "Swarm ID returned by start_research_swarm — use to poll current status",
  ),
};

export const metadata: ToolMetadata = {
  name: researchSwarmStatus.name,
  description: researchSwarmStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function researchSwarmStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(researchSwarmStatus.name, args, ctx, {
    surface: "mcp",
  });
  return researchSwarmStatus.output.parse(output);
}
