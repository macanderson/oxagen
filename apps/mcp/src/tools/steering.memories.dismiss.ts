import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoriesDismiss } from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...steeringMemoriesDismiss.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoriesDismiss.name,
  description: steeringMemoriesDismiss.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function dismissMemoriesTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoriesDismiss.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringMemoriesDismiss.output.parse(output));
}
