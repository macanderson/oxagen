import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { researchSwarmStart } from "@oxagen/oxagen/contracts/research.swarm.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...researchSwarmStart.input.shape,
  topic: researchSwarmStart.input.shape.topic.describe(
    "The research topic to investigate comprehensively",
  ),
  depth: researchSwarmStart.input.shape.depth.describe(
    "Research depth: shallow (3 searches), medium (8 searches), deep (15 searches)",
  ),
  maxParallel: researchSwarmStart.input.shape.maxParallel.describe(
    "Maximum number of concurrent search tasks (1–20, default 5)",
  ),
  targetLabel: researchSwarmStart.input.shape.targetLabel.describe(
    "KnowledgeNode label for top-level nodes created from the research results",
  ),
  searchDepth: researchSwarmStart.input.shape.searchDepth.describe(
    "Search depth mode: basic or advanced",
  ),
};

export const metadata: ToolMetadata = {
  name: researchSwarmStart.name,
  description: researchSwarmStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function researchSwarmStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(researchSwarmStart.name, args, ctx, {
    surface: "mcp",
  });
  return researchSwarmStart.output.parse(output);
}
