import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticRelationshipList } from "@oxagen/oxagen/contracts/semantic.relationship.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticRelationshipList.input.shape,
};

export const metadata: ToolMetadata = {
  name: semanticRelationshipList.name,
  description: semanticRelationshipList.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function semanticRelationshipListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticRelationshipList.name, args, ctx, { surface: "mcp" });
  return semanticRelationshipList.output.parse(output);
}
