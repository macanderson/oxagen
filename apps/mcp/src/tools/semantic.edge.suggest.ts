import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticEdgeSuggest } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticEdgeSuggest.input.shape,
  confidenceMin: semanticEdgeSuggest.input.shape.confidenceMin.describe(
    "Lower bound on confidence (inclusive). Use to skip very low-confidence noise.",
  ),
  confidenceMax: semanticEdgeSuggest.input.shape.confidenceMax.describe(
    "Upper bound on confidence (inclusive). Typically set to the workspace auto-accept threshold.",
  ),
  limit: semanticEdgeSuggest.input.shape.limit.describe(
    "Maximum suggestions to return (1–250, default 50).",
  ),
};

export const metadata: ToolMetadata = {
  name: semanticEdgeSuggest.name,
  description: semanticEdgeSuggest.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function semanticEdgeSuggestTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticEdgeSuggest.name, args, ctx, { surface: "mcp" });
  return semanticEdgeSuggest.output.parse(output);
}
