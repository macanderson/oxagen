import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRepoAdopt } from "@oxagen/oxagen/contracts/steering_repo.adopt";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = steeringRepoAdopt.input.shape;

// An adoption writes check runs and publishes a steering version. A second
// call finds every merge already adopted and adopts nothing more.
export const metadata: ToolMetadata = {
  name: steeringRepoAdopt.name,
  description: steeringRepoAdopt.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function adoptSteeringMergesTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRepoAdopt.name, {}, ctx, {
    surface: "mcp",
  });
  return steeringRepoAdopt.output.parse(output);
}
