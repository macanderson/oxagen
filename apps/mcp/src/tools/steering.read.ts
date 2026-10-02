import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRead } from "@oxagen/oxagen/contracts/steering.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

/**
 * The tool an agent calls to read one steering record, or one file from a
 * skill's folder, that its index or search_steering named.
 */
export const schema = steeringRead.input.shape;

export const metadata: ToolMetadata = {
  name: steeringRead.name,
  description: steeringRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function readSteeringTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRead.name, args, ctx, {
    surface: "mcp",
  });
  return steeringRead.output.parse(output);
}
