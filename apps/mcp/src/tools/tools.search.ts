import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolsSearch } from "@oxagen/oxagen/contracts/tools.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...toolsSearch.input.shape };

export const metadata: ToolMetadata = {
  name: toolsSearch.name,
  description: toolsSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function searchToolsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolsSearch.name, args, ctx, { surface: "mcp" });
  return toolsSearch.output.parse(output);
}
