import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextPrDiffGet } from "@oxagen/oxagen/contracts/context.pr.diff.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextPrDiffGet.input.shape };

export const metadata: ToolMetadata = {
  name: contextPrDiffGet.name,
  description: contextPrDiffGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextPrDiffGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextPrDiffGet.name, args, ctx, {
    surface: "mcp",
  });
  return contextPrDiffGet.output.parse(output);
}
