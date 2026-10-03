import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...shellNavCountsGet.input.shape };

export const metadata: ToolMetadata = {
  name: shellNavCountsGet.name,
  description: shellNavCountsGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getNavCountsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(shellNavCountsGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(shellNavCountsGet.output.parse(output));
}
