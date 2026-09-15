import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextPrMerge.input.shape };

export const metadata: ToolMetadata = {
  name: contextPrMerge.name,
  description: contextPrMerge.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function contextPrMergeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextPrMerge.name, args, ctx, {
    surface: "mcp",
  });
  return contextPrMerge.output.parse(output);
}
