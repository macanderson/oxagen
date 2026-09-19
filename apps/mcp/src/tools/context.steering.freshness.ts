import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

/**
 * The tool an agent calls to find out whether the records it is steering on
 * are the ones in force.
 *
 * Oxagen wraps whatever agent a team runs, and not every harness offers a
 * pre-prompt hook. For those, this is the reach that is guaranteed: any
 * agent already talking to Oxagen over MCP can ask, and an agent that knows
 * its checkout is behind can say so in its own transcript rather than
 * quietly applying retired records. It answers later than a hook does, at
 * the first tool call rather than before the prompt, which is why
 * `oxagen steering hooks install` is still the better path where a harness
 * supports one.
 */
export const schema = contextSteeringFreshness.input.shape;

export const metadata: ToolMetadata = {
  name: contextSteeringFreshness.name,
  description: contextSteeringFreshness.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getSteeringFreshnessTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextSteeringFreshness.name, args, ctx, {
    surface: "mcp",
  });
  return contextSteeringFreshness.output.parse(output);
}
