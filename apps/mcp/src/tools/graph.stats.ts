import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphStats.input.shape,
  includeByType: graphStats.input.shape.includeByType.describe(
    "Include breakdown by node label and edge type in the response",
  ),
};

export const metadata: ToolMetadata = {
  name: graphStats.name,
  description: graphStats.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphStatsTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphStats.name, args, ctx, { surface: "mcp" });
  return graphStats.output.parse(output);
}
