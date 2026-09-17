import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextPrGet.input.shape };

export const metadata: ToolMetadata = {
  name: contextPrGet.name,
  description: contextPrGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextPrGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextPrGet.name, args, ctx, { surface: "mcp" });
  return contextPrGet.output.parse(output);
}
