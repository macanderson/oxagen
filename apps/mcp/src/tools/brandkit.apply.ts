import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { brandkitApply } from "@oxagen/oxagen/contracts/brandkit.apply";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...brandkitApply.input.shape,
  workspaceId: brandkitApply.input.shape.workspaceId.describe(
    "The workspace the brand kit belongs to",
  ),
  brandKitId: brandkitApply.input.shape.brandKitId.describe(
    "ID of the brand kit to apply",
  ),
  targetFileId: brandkitApply.input.shape.targetFileId.describe(
    "Cloud file ID of the target document",
  ),
};

export const metadata: ToolMetadata = {
  name: brandkitApply.name,
  description: brandkitApply.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function brandkitApplyTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(brandkitApply.name, args, ctx, { surface: "mcp" });
  return brandkitApply.output.parse(output);
}
