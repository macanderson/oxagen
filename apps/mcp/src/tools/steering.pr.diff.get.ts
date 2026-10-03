import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringPrDiffGet } from "@oxagen/oxagen/contracts/steering.pr.diff.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...steeringPrDiffGet.input.shape };

export const metadata: ToolMetadata = {
  name: steeringPrDiffGet.name,
  description: steeringPrDiffGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringPrDiffGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringPrDiffGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringPrDiffGet.output.parse(output));
}
