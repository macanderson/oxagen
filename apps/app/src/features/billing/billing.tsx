// Billing (ARCHITECTURE.md §1.4): what the organization is subscribed to, how
// it is billed past its allowance, how much of this month's bucket is left,
// whether auto top-up refills it, the rate it pays, buying more units, its
// invoices, and the in-app AI usage credit balance with its top-up — the
// second meter (§3.9). The page makes five reads; money appears only in the
// rate block, the purchase total, the invoices and the credit balance.
import {
  canTierBuyCredits,
  CREDIT_TOPUP_PRESETS_USD,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { PURCHASE_GAU_MAX } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { AutoTopup } from "./auto-topup";
import { BillingMode } from "./billing-mode";
import { BucketMeter } from "./bucket-meter";
import { CheckoutBanner, checkoutOutcome } from "./checkout-banner";
import { ContractRateBlock } from "./contract-rate";
import { Invoices } from "./invoices";
import { Plan } from "./plan";
import { PurchaseForm } from "./purchase-form";
import { UsageCreditsSection } from "./usage-credits";

export async function Billing({
  ctx,
  source,
  checkout,
  cursor,
}: {
  ctx: OrgCtx;
  source: DataSource;
  /** `?checkout=` as the URL carried it, after a Stripe Checkout round trip. */
  checkout: string | null;
  /** The invoices page the URL asked for; null is the newest. */
  cursor: string | null;
}) {
  const [plan, bucket, rate, invoices, credits] = await Promise.all([
    source.billing.plan(ctx),
    source.billing.bucket(ctx),
    source.billing.contractRate(ctx),
    source.billing.invoices(ctx, { cursor }),
    source.billing.usageCredits(ctx),
  ]);
  const buys = ctx.orgRole === "owner" || ctx.orgRole === "billing";
  // Two things decide whether the top-up is offered, and the section says
  // which one refused. `purchase_credits` needs the role, and its checkout
  // refuses a Free organization outright (canTierBuyCredits), so offering an
  // owner of a Free org the form gives them one that cannot succeed. The tier
  // is the contracted rate's, the same figure resolveContractTerms answers the
  // checkout with. A rate the page could not read proves nothing about the
  // tier, so the form stays offered and the handler remains the authority.
  const topUp = !buys
    ? "role"
    : rate.ok && !canTierBuyCredits(rate.value.tier)
      ? "plan"
      : "ok";
  return (
    <div className="flex flex-col gap-6">
      <CheckoutBanner outcome={checkoutOutcome(checkout)} />
      <Plan plan={plan} />
      <BillingMode bucket={bucket} />
      <BucketMeter bucket={bucket} />
      <AutoTopup
        bucket={bucket}
        blockSizeGau={rate.ok ? rate.value.blockSizeGau : null}
        editable={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
        org={ctx.orgSlug}
      />
      <ContractRateBlock rate={rate} />
      <PurchaseForm
        org={ctx.orgSlug}
        bucket={bucket}
        rate={rate}
        maxGau={PURCHASE_GAU_MAX}
        allowed={buys}
      />
      <Invoices invoices={invoices} cursor={cursor} org={ctx.orgSlug} />
      <UsageCreditsSection
        org={ctx.orgSlug}
        credits={credits}
        topUp={topUp}
        presetsUsd={CREDIT_TOPUP_PRESETS_USD}
        minUsd={MIN_CREDIT_TOPUP_USD}
      />
    </div>
  );
}
