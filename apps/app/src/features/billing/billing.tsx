// Billing (ARCHITECTURE.md §1.4): what the organization is subscribed to, how
// it is billed past its allowance, how much of this month's bucket is left,
// whether auto top-up refills it, the rate it pays, buying more units and its
// invoices. The page makes four reads; money appears only in the rate block,
// the purchase total and the invoices.
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
  const [plan, bucket, rate, invoices] = await Promise.all([
    source.billing.plan(ctx),
    source.billing.bucket(ctx),
    source.billing.contractRate(ctx),
    source.billing.invoices(ctx, { cursor }),
  ]);
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
      />
      <ContractRateBlock rate={rate} />
      <PurchaseForm
        org={ctx.orgSlug}
        bucket={bucket}
        rate={rate}
        allowed={ctx.orgRole === "owner" || ctx.orgRole === "billing"}
      />
      <Invoices invoices={invoices} cursor={cursor} org={ctx.orgSlug} />
    </div>
  );
}
