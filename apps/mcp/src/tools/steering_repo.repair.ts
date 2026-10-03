import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = steeringRepoRepair.input.shape;

// Repair writes the settings the baseline prescribes and nothing else, so a
// second call finds nothing left to write.
export const metadata: ToolMetadata = {
  name: steeringRepoRepair.name,
  description: steeringRepoRepair.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repairSteeringRepoTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRepoRepair.name, {}, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringRepoRepair.output.parse(output));
}
