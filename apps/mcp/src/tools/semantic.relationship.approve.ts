import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticRelationshipApprove } from "@oxagen/oxagen/contracts/semantic.relationship.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticRelationshipApprove.input.shape,
};

export const metadata: ToolMetadata = {
  name: semanticRelationshipApprove.name,
  description: semanticRelationshipApprove.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export default async function semanticRelationshipApproveTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticRelationshipApprove.name, args, ctx, { surface: "mcp" });
  return semanticRelationshipApprove.output.parse(output);
}
