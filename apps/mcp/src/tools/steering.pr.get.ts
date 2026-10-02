import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringPrGet } from "@oxagen/oxagen/contracts/steering.pr.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringPrGet.input.shape };

export const metadata: ToolMetadata = {
  name: steeringPrGet.name,
  description: steeringPrGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringPrGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringPrGet.name, args, ctx, { surface: "mcp" });
  return steeringPrGet.output.parse(output);
}
