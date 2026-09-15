import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { billingGauBucketPurchase } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import {
  billingProvider,
  blockPriceCents,
  ensureStripeCustomer,
  readOrgBillingSettings,
  resolveContractTerms,
} from "@oxagen/billing";
import { requireEnv } from "@oxagen/config/env";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";

/**
 * purchase_gau_bucket — buy governed action units in blocks at the
 * organisation's contracted rate (ADR-055 §6, apps/app/ARCHITECTURE.md §3.9
 * item 11).
 *
 * Flow:
 *   1. Role gate — assertOrgRole: org Owner or Billing, for the signed-in
 *      user or the creator of the API key (resolveActingUserId). The kernel's IAM
 *      check allows every capability for a non-enterprise org, so the
 *      handler owns this check (§3.2, INV-29).
 *   2. Mode — an org approved for invoice billing is never capped and buys
 *      nothing: `HandlerError { conflict, invoice_billed }`. The page does not
 *      render the form in that mode; the refusal is for API and MCP callers.
 *   3. Terms — `resolveContractTerms` at submit time, so a terms change
 *      between render and submit prices the blocks the customer will see on
 *      Checkout. A quantity that is not a whole number of blocks is
 *      `invalid_input`.
 *   4. Customer — `ensureStripeCustomer`, which writes
 *      `org_billing_settings.stripe_customer_id` on first use.
 *   5. Session — `createGauCheckout` with the return paths prefixed by
 *      `NEXT_PUBLIC_APP_URL`; the contract admits app-relative paths only.
 *
 * There is no tier gate and no saved-card check: the Checkout saves the card
 * it collects (`setup_future_usage: "off_session"`) and the webhook grant
 * makes it the default, so this is the rev1 card-saving path for a Free org
 * (spec §4.2, ADR-055 §6). Nothing pending is inserted; the paid session's
 * metadata is the whole record of the sale and the webhook grant reads it.
 */
export const billingGauBucketPurchaseHandler: CapabilityHandler<
  typeof billingGauBucketPurchase
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Billing"] },
  );

  const settings = await readOrgBillingSettings(ctx.orgId);
  if (settings.approvedForInvoiceBilling) {
    throw new HandlerError({
      code: "conflict",
      reason: "invoice_billed",
      message:
        "This organisation is billed by invoice: governed actions are never capped and units are not bought in blocks.",
    });
  }

  const terms = await resolveContractTerms(ctx.orgId);
  if (input.quantityGau % terms.blockSizeGau !== 0) {
    throw new CapabilityError(
      billingGauBucketPurchase.name,
      "invalid_input",
      `quantityGau must be a multiple of the block size (${terms.blockSizeGau})`,
    );
  }
  const blocks = input.quantityGau / terms.blockSizeGau;

  const customerId = await ensureStripeCustomer(ctx.orgId);
  const { NEXT_PUBLIC_APP_URL } = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
  const origin = NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

  const session = await billingProvider().createGauCheckout({
    customerId,
    orgId: ctx.orgId,
    quantityGau: input.quantityGau,
    blocks,
    blockPriceCents: blockPriceCents(terms),
    ratePerGauMicros: terms.ratePerGauMicros,
    currency: terms.currency,
    successUrl: `${origin}${input.successPath}`,
    cancelUrl: `${origin}${input.cancelPath}`,
  });

  emitSecurityEvent({
    eventType: "billing.checkout_initiated",
    actorUserId: actingUserId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: billingGauBucketPurchase.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      quantityGau: input.quantityGau,
      blocks,
      blockSizeGau: terms.blockSizeGau,
      termsSource: terms.source,
      sessionId: session.sessionId,
      surface: ctx.surface,
    },
    "purchase_gau_bucket: checkout session created",
  );

  return {
    checkoutUrl: session.url,
    quantityGau: input.quantityGau,
    blockSizeGau: terms.blockSizeGau,
    blocks,
  };
};
