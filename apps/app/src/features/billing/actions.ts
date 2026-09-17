"use server";
// The Billing page's writes.
//
// Auto top-up: whether the recorder charges the saved card when the bucket runs
// out, and for how many blocks, through set_auto_topup on the kernel seam. The
// handler checks the role (Owner or Admin, INV-29) and returns the two fields
// as stored.
//
// Buy governed action units (ARCHITECTURE.md §1.4, §3.9): the purchase form's
// write. The quantity must be a whole number of blocks at the block size the
// page read from get_contract_rate; purchase_gau_bucket prices the blocks from
// the terms in force at submit time and refuses a quantity that is not a
// multiple of them. A quantity above PURCHASE_GAU_MAX is refused here with its
// own code, so the form can say so. Checkout returns to the Billing page's
// ?checkout= banner, and the browser is sent on only to a URL parseCheckoutUrl
// accepts.
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import {
  billingCreditsPurchase,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
import {
  billingGauBucketPurchase,
  PURCHASE_GAU_MAX,
} from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { captureError } from "@oxagen/telemetry";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { parseCheckoutUrl } from "@/shared/checkout-url";
import { redirectToCheckout } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

/** Blocks charged per top-up: the contract's and the column's bounds. */
const MIN_BLOCKS = 1;
const MAX_BLOCKS = 100;

export type PurchaseState = ActionResult<never> | null;

export type CreditTopupState = ActionResult<never> | null;

/** A whole number with no sign, no leading zero, no exponent and no separator. */
const WHOLE_NUMBER = /^[1-9]\d*$/;

/**
 * Blocks that are not an integer in 1…100 are `invalid` on the `blocks` field
 * and no capability runs.
 */
export async function setAutoTopup(
  org: string,
  input: { enabled: boolean; blocks: number },
): Promise<ActionResult<ContractOutput<typeof billingAutoTopupSet>>> {
  const ctx = await requireViewer(org);
  const { enabled, blocks } = input;
  if (!Number.isInteger(blocks) || blocks < MIN_BLOCKS || blocks > MAX_BLOCKS)
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "blocks",
    };
  return kernelWrite(ctx, billingAutoTopupSet, { enabled, blocks });
}

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

/**
 * Top up the in-app AI usage credit balance (§1.4, §3.9 the second meter).
 *
 * The amount is a face-value figure in whole dollars, at least the contract's
 * minimum; anything else is `invalid` on the `amountUsd` field and no
 * capability runs. `purchase_credits` takes absolute return URLs rather than
 * app-relative paths, so the two are built here from the billing route on
 * NEXT_PUBLIC_APP_URL. Success returns to `?checkout=credits`, the usage
 * credit meter's outcome, so the banner names the balance the payment lands on
 * rather than the governed action unit bucket (§3.9). The handler checks the role again, and the browser is
 * sent on only to a URL parseCheckoutUrl accepts.
 */
export async function purchaseCredits(
  org: string,
  _prev: CreditTopupState,
  form: FormData,
): Promise<ActionResult<never>> {
  const ctx = await requireViewer(org);
  const raw = form.get("amountUsd");
  const amountUsd =
    typeof raw === "string" && WHOLE_NUMBER.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(amountUsd) || amountUsd < MIN_CREDIT_TOPUP_USD) {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "amountUsd",
    };
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (!origin) {
    captureError({
      error: new Error("app_url_missing"),
      source: "app",
      orgId: ctx.orgId,
      context: "billing.credits app_url_missing",
    });
    return { ok: false, reason: "unavailable", code: "app_url_missing" };
  }

  const result = await kernelWrite(ctx, billingCreditsPurchase, {
    amountUsd,
    successUrl: `${origin}${routes.billing(ctx.orgSlug, { checkout: "credits" })}`,
    cancelUrl: `${origin}${routes.billing(ctx.orgSlug, { checkout: "cancel" })}`,
  });
  if (!result.ok) return result;
  const url = parseCheckoutUrl(result.value.url);
  if (url === null) {
    captureError({
      error: new Error("checkout_url_refused"),
      source: "app",
      orgId: ctx.orgId,
      context: "billing.credits checkout_url_refused",
    });
    return { ok: false, reason: "unavailable", code: "checkout_url_refused" };
  }
  return redirectToCheckout(url);
}
