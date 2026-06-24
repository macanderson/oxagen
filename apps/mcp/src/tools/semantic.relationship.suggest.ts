import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticRelationshipSuggest } from "@oxagen/oxagen/contracts/semantic.relationship.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticRelationshipSuggest.input.shape,
};

export const metadata: ToolMetadata = {
  name: semanticRelationshipSuggest.name,
  description: semanticRelationshipSuggest.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function semanticRelationshipSuggestTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticRelationshipSuggest.name, args, ctx, { surface: "mcp" });
  return semanticRelationshipSuggest.output.parse(output);
}
