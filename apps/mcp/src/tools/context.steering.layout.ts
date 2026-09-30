import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextSteeringLayout } from "@oxagen/oxagen/contracts/context.steering.layout";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

/**
 * The tool an agent calls to learn which layout the workspace's bound
 * repository uses before it proposes a record (#4765). A steering repository
 * keeps records under `steering/`, a legacy one under `.oxagen/rules/`, and
 * `open_context_pr` picks the path and branch from this same read.
 */
export const schema = contextSteeringLayout.input.shape;

export const metadata: ToolMetadata = {
  name: contextSteeringLayout.name,
  description: contextSteeringLayout.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getSteeringLayoutTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextSteeringLayout.name, args, ctx, {
    surface: "mcp",
  });
  return contextSteeringLayout.output.parse(output);
}
