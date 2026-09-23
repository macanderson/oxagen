import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = contextSteeringDeliveries.input.shape;

export const metadata: ToolMetadata = {
  name: contextSteeringDeliveries.name,
  description: contextSteeringDeliveries.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getSteeringDeliveriesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextSteeringDeliveries.name, args, ctx, {
    surface: "mcp",
  });
  return contextSteeringDeliveries.output.parse(output);
}
