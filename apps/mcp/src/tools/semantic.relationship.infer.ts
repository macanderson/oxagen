import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticRelationshipInfer } from "@oxagen/oxagen/contracts/semantic.relationship.infer";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticRelationshipInfer.input.shape,
};

export const metadata: ToolMetadata = {
  name: semanticRelationshipInfer.name,
  description: semanticRelationshipInfer.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export default async function semanticRelationshipInferTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticRelationshipInfer.name, args, ctx, { surface: "mcp" });
  return semanticRelationshipInfer.output.parse(output);
}
