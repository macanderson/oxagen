import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingGauBucketPurchase } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingGauBucketPurchase.input.shape,
  quantityGau: billingGauBucketPurchase.input.shape.quantityGau.describe(
    "Governed action units to buy: a whole number of blocks at the organisation's contracted block size (get_contract_rate.blockSizeGau), at most 1,000,000.",
  ),
  successPath: billingGauBucketPurchase.input.shape.successPath.describe(
    "App-relative path Checkout returns to on success, e.g. /acme/billing?checkout=success.",
  ),
  cancelPath: billingGauBucketPurchase.input.shape.cancelPath.describe(
    "App-relative path Checkout returns to on cancel, e.g. /acme/billing?checkout=cancel.",
  ),
};

export const metadata: ToolMetadata = {
  name: billingGauBucketPurchase.name,
  description: billingGauBucketPurchase.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function billingGauBucketPurchaseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingGauBucketPurchase.name, args, ctx, {
    surface: "mcp",
  });
  return billingGauBucketPurchase.output.parse(output);
}
