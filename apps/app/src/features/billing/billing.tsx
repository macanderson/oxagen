// Billing (pages/billing.md; ARCHITECTURE.md §1.4, §3.9): the page body in the
// mockup's shape, under the header page.tsx renders with the one gold action,
// Change plan (`BillingActions`, below). Four tiles summarise the plan, this month's governed action units, the contracted
// rate and what is due. Below, two columns: This month, Meters and Invoices on
// the left; the price list, Auto top-up, buying governed action units, usage
// credits and What counts on the right, stacking into one column on a phone.
// Every tile is a rollup of a section beneath it. The page makes five reads,
// plus the newest invoices page when the URL asks for an older one, since the
// tiles and This month always sum the newest page.
import {
  canTierBuyCredits,
  CREDIT_TOPUP_PRESETS_USD,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { PURCHASE_GAU_MAX } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { UPGRADE_PLANS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { type Money as MoneyValue, mulMicros } from "@/data/contracts/money";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { AutoTopup } from "./auto-topup";
import {
  ChangePlan,
  type PlanChangeBlock,
  type PlanOption,
} from "./change-plan";
import { CheckoutBanner, checkoutOutcome } from "./checkout-banner";
import { Invoices } from "./invoices";
import { Meters } from "./meters";
import { PriceList } from "./price-list";
import { PurchaseForm } from "./purchase-form";
import { SummaryTiles } from "./summary";
import { ThisMonth } from "./this-month";
import { UsageCreditsSection } from "./usage-credits";
import { WhatCounts } from "./what-counts";

const ONE_CENT: MoneyValue = { micros: "10000", currency: "USD" };

/** The plans the Change plan dialog offers, priced as Money on the server. */
const PLAN_OPTIONS: readonly PlanOption[] = UPGRADE_PLANS.map((plan) => ({
  slug: plan.slug,
  tier: plan.tier,
  monthly: mulMicros(ONE_CENT, plan.monthlyCents),
  annual: mulMicros(ONE_CENT, plan.annualCents),
  includedGauPerMonth: plan.includedGauPerMonth,
}));

/** Who may start a plan change: the same roles `start_subscription_upgrade` gates. */
const changesPlan = (ctx: OrgCtx) =>
  ctx.orgRole === "owner" || ctx.orgRole === "billing";

/**
 * The header's actions: Change plan, the page's one gold action. Rendered by
 * page.tsx beside the h1, so it reads the plan on its own; the body's reads
 * are its own and the two do not wait on each other.
 * `start_subscription_upgrade` needs Owner or Billing and refuses a second
 * subscription; the dialog says which stopped it. An unread plan proves
 * nothing, so the form is offered and the handler decides.
 */
export async function BillingActions({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const plan = await source.billing.plan(ctx);
  const subscription = plan.ok ? plan.value.subscription : null;
  let blocked: PlanChangeBlock | null = null;
  if (!changesPlan(ctx)) blocked = { kind: "role" };
  else if (subscription !== null)
    blocked = { kind: "subscribed", plan: subscription.plan };
  return (
    <ChangePlan org={ctx.orgSlug} plans={PLAN_OPTIONS} blocked={blocked} />
  );
}

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
  const [plan, bucket, rate, invoices, credits, newest] = await Promise.all([
    source.billing.plan(ctx),
    source.billing.bucket(ctx),
    source.billing.contractRate(ctx),
    source.billing.invoices(ctx, { cursor }),
    source.billing.usageCredits(ctx),
    cursor === null ? null : source.billing.invoices(ctx, { cursor: null }),
  ]);
  const newestInvoices = newest ?? invoices;
  const buys = changesPlan(ctx);
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
    <div className="flex flex-col gap-4">
      <CheckoutBanner outcome={checkoutOutcome(checkout)} />
      <SummaryTiles
        plan={plan}
        bucket={bucket}
        rate={rate}
        invoices={newestInvoices}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ThisMonth plan={plan} bucket={bucket} invoices={newestInvoices} />
          <Meters bucket={bucket} credits={credits} />
          <Invoices invoices={invoices} cursor={cursor} org={ctx.orgSlug} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PriceList />
          <AutoTopup
            bucket={bucket}
            blockSizeGau={rate.ok ? rate.value.blockSizeGau : null}
            editable={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
            org={ctx.orgSlug}
          />
          <PurchaseForm
            org={ctx.orgSlug}
            bucket={bucket}
            rate={rate}
            maxGau={PURCHASE_GAU_MAX}
            allowed={buys}
          />
          <UsageCreditsSection
            org={ctx.orgSlug}
            credits={credits}
            topUp={topUp}
            presetsUsd={CREDIT_TOPUP_PRESETS_USD}
            minUsd={MIN_CREDIT_TOPUP_USD}
          />
          <WhatCounts />
        </div>
      </div>
    </div>
  );
}
