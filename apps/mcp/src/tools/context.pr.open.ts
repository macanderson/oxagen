import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextPrOpen.input.shape };

export const metadata: ToolMetadata = {
  name: contextPrOpen.name,
  description: contextPrOpen.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextPrOpenTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextPrOpen.name, args, ctx, {
    surface: "mcp",
  });
  return contextPrOpen.output.parse(output);
}
