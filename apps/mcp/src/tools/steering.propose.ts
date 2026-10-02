import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringPropose } from "@oxagen/oxagen/contracts/steering.propose";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

/**
 * The tool an agent calls to open a steering PR without a clone. Oxagen names
 * the agent and the run in each record's provenance from the request's gateway
 * key, so the input carries neither (servers/proposer.ts).
 */
export const schema = steeringPropose.input.shape;

export const metadata: ToolMetadata = {
  name: steeringPropose.name,
  description: steeringPropose.description,
  annotations: {
    readOnlyHint: false,
    // It opens a PR. Nothing changes what an agent is told until a person merges it.
    destructiveHint: false,
    // Each call opens its own branch and PR.
    idempotentHint: false,
  },
};

export default async function proposeSteeringTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringPropose.name, args, ctx, {
    surface: "mcp",
  });
  return steeringPropose.output.parse(output);
}
