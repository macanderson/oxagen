import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRepoGet } from "@oxagen/oxagen/contracts/steering_repo.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = steeringRepoGet.input.shape;

export const metadata: ToolMetadata = {
  name: steeringRepoGet.name,
  description: steeringRepoGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getSteeringRepoTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRepoGet.name, {}, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringRepoGet.output.parse(output));
}
