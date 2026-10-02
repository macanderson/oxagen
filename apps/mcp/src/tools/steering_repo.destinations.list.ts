import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRepoDestinationsList } from "@oxagen/oxagen/contracts/steering_repo.destinations.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = steeringRepoDestinationsList.input.shape;

export const metadata: ToolMetadata = {
  name: steeringRepoDestinationsList.name,
  description: steeringRepoDestinationsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listSteeringRepoDestinationsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRepoDestinationsList.name, args, ctx, {
    surface: "mcp",
  });
  return steeringRepoDestinationsList.output.parse(output);
}
