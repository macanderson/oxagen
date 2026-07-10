import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  resellerRebillPreview,
  resellerRebillPreviewFields,
} from "@oxagen/oxagen/contracts/billing.reseller_rebill.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract input is refined (a ZodEffects with no `.shape`), so build the
// arg map from the exported raw fields.
export const schema = { ...resellerRebillPreviewFields };

export const metadata: ToolMetadata = {
  name: resellerRebillPreview.name,
  description: resellerRebillPreview.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerRebillPreviewTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerRebillPreview.name, args, ctx, {
    surface: "mcp",
  });
  return resellerRebillPreview.output.parse(output);
}
