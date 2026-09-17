import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolsLoad } from "@oxagen/oxagen/contracts/tools.load";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...toolsLoad.input.shape };

export const metadata: ToolMetadata = {
  name: toolsLoad.name,
  description: toolsLoad.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function loadToolsTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolsLoad.name, args, ctx, { surface: "mcp" });
  return toolsLoad.output.parse(output);
}
