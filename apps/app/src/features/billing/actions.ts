"use server";
// Buy governed action units (ARCHITECTURE.md §1.4, §3.9): the purchase form's
// write. The quantity must be a whole number of blocks at the block size the
// page read from get_contract_rate; purchase_gau_bucket prices the blocks from
// the terms in force at submit time and refuses a quantity that is not a
// multiple of them. A quantity above PURCHASE_GAU_MAX is refused here with its
// own code, so the form can say so. Checkout returns to the Billing page's
// ?checkout= banner, and the browser is sent on only to a URL parseCheckoutUrl
// accepts.
import {
  billingGauBucketPurchase,
  PURCHASE_GAU_MAX,
} from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { captureError } from "@oxagen/telemetry";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { parseCheckoutUrl } from "@/shared/checkout-url";
import { redirectToCheckout } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

export type PurchaseState = ActionResult<never> | null;

/** A whole number with no sign, no leading zero, no exponent and no separator. */
const WHOLE_NUMBER = /^[1-9]\d*$/;

/**
 * `org` and `blockSizeGau` are bound by the form. The organization is resolved
 * again here, and the handler checks the role and the block size again.
 */
export async function purchaseGau(
  org: string,
  blockSizeGau: number,
  _prev: PurchaseState,
  form: FormData,
): Promise<ActionResult<never>> {
  const ctx = await requireViewer(org);
  const raw = form.get("quantityGau");
  const quantityGau =
    typeof raw === "string" && WHOLE_NUMBER.test(raw) ? Number(raw) : NaN;
  if (
    !Number.isSafeInteger(quantityGau) ||
    !Number.isSafeInteger(blockSizeGau) ||
    blockSizeGau <= 0 ||
    quantityGau % blockSizeGau !== 0
  ) {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "quantityGau",
    };
  }
  if (quantityGau > PURCHASE_GAU_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: "quantity_above_max",
      field: "quantityGau",
    };
  }
  const result = await kernelWrite(ctx, billingGauBucketPurchase, {
    quantityGau,
    successPath: routes.billing(ctx.orgSlug, { checkout: "success" }),
    cancelPath: routes.billing(ctx.orgSlug, { checkout: "cancel" }),
  });
  if (!result.ok) return result;
  const url = parseCheckoutUrl(result.value.checkoutUrl);
  if (url === null) {
    captureError({
      error: new Error("checkout_url_refused"),
      source: "app",
      orgId: ctx.orgId,
      context: "billing.purchase checkout_url_refused",
    });
    return { ok: false, reason: "unavailable", code: "checkout_url_refused" };
  }
  return redirectToCheckout(url);
}
