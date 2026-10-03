import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringSearch } from "@oxagen/oxagen/contracts/steering.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

/**
 * The tool an agent calls to find steering its index did not list. Cursor
 * reads all of its steering this way: a rule in Cursor's dashboard tells it
 * to call this at the start of each task (packages/steering-bundle/src/
 * cursor.ts).
 */
export const schema = steeringSearch.input.shape;

export const metadata: ToolMetadata = {
  name: steeringSearch.name,
  description: steeringSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function searchSteeringTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringSearch.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringSearch.output.parse(output));
}
