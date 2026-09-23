// Billing (pages/billing.md; ARCHITECTURE.md §1.4, §3.9): the page body in the
// mockup's shape. The header carries the one gold action, Change plan. Four
// tiles summarise the plan, the governed actions priced this period,
// the evidence retained and what is due. Below, two columns: This period,
// Meters and Invoices on the left; the price list and Billable units on the
// right, stacking into one column on a phone. Every tile is a rollup of a
// section beneath it (statement.ts).
//
// Beneath Billable units sit Auto top-up, Buy governed actions and Token
// balance. The rendered mock does not draw them. The spec describes them in
// its text (Mac kept them on 2026-09-23, macanderson/oxagen-roadmap#67). They
// are how a prepaid organization pays, and the pay journey (e2e/pay.spec.ts)
// buys through the second. None of their buttons is gold.
//
// The page makes six reads. A refusal on any of them is the denied state and
// replaces the body, header included. A failure of any of the five reads the
// design draws from (the plan, the bucket, the rate, the retention terms and
// the invoices) is the error state: the design has no partially loaded page,
// so every tile and line either reconciles or the body is replaced. The token
// balance read feeds only its own panel and says its failure there. An
// organization with no subscription, no invoice and no governed action yet is
// the empty state: the design's panel, then Buy governed actions, so it can
// buy its first block.
import {
  canTierBuyCredits,
  CREDIT_TOPUP_PRESETS_USD,
  MIN_CREDIT_TOPUP_USD,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { PURCHASE_GAU_MAX } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { UPGRADE_PLANS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ContractRate,
  GauBucket,
  UsageCredits,
} from "@/data/contracts/billing";
import { type Money as MoneyValue, mulMicros } from "@/data/contracts/money";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";
import { AutoTopup } from "./auto-topup";
import { BillableUnits } from "./billable-units";
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
import { statementFor } from "./statement";
import {
  BillingDenied,
  BillingEmpty,
  BillingError,
  BillingPending,
} from "./states";
import { SummaryTiles } from "./summary";
import { ThisPeriod } from "./this-period";
import { type TopUpState, UsageCreditsSection } from "./usage-credits";

const ONE_CENT: MoneyValue = { micros: "10000", currency: "USD" };

/** The plans the Change plan dialog offers, priced as Money on the server. */
const PLAN_OPTIONS: readonly PlanOption[] = UPGRADE_PLANS.map((plan) => ({
  slug: plan.slug,
  tier: plan.tier,
  monthly: mulMicros(ONE_CENT, plan.monthlyCents),
  annual: mulMicros(ONE_CENT, plan.annualCents),
}));

/** Who may start a plan change or buy: the roles `start_subscription_upgrade` and the purchases gate. */
const buysFor = (ctx: OrgCtx) =>
  ctx.orgRole === "owner" || ctx.orgRole === "billing";

type Failed = Exclude<Read<unknown>, { ok: true }>;
type ReadError = Extract<Failed, { reason: "error" }>;

/** The instant after the reads, for the error state's trace line. */
function instantAfterRead(): Date {
  return new Date();
}

/** The trace line's time as the design prints it: `2026-09-11 09:16:04Z`. */
export function traceTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Whether the viewer is offered the token top-up, and when not, what refused it. */
function topUpFor(buys: boolean, rate: Read<ContractRate>): TopUpState {
  // `purchase_credits` needs the role, and its checkout refuses a Free
  // organization outright (canTierBuyCredits). The tier is the contracted
  // rate's, the figure resolveContractTerms answers the checkout with. A rate
  // the page could not read proves nothing about the tier, so the form stays
  // offered and the handler remains the authority.
  if (!buys) return "role";
  return rate.ok && !canTierBuyCredits(rate.value.tier) ? "plan" : "ok";
}

function PaymentControls({
  ctx,
  bucket,
  rate,
  credits,
  buys,
}: {
  ctx: OrgCtx;
  bucket: Read<GauBucket>;
  rate: Read<ContractRate>;
  credits: Read<UsageCredits>;
  buys: boolean;
}) {
  return (
    <>
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
        topUp={topUpFor(buys, rate)}
        presetsUsd={CREDIT_TOPUP_PRESETS_USD}
        minUsd={MIN_CREDIT_TOPUP_USD}
      />
    </>
  );
}

export async function Billing({
  ctx,
  source,
  title,
  viewerName,
  checkout,
  cursor,
}: {
  ctx: OrgCtx;
  source: DataSource;
  /** The translated `pages.billing`, the same string generateMetadata returns. */
  title: string;
  /** The signed-in person's name, for the denied state; null when the session has none. */
  viewerName: string | null;
  /** `?checkout=` as the URL carried it, after a Stripe Checkout round trip. */
  checkout: string | null;
  /** The invoices page the URL asked for; null is the newest. */
  cursor: string | null;
}) {
  const [plan, bucket, rate, retention, invoices, credits] = await Promise.all([
    source.billing.plan(ctx),
    source.billing.bucket(ctx),
    source.billing.contractRate(ctx),
    source.billing.retention(ctx),
    source.billing.invoices(ctx, { cursor }),
    source.billing.usageCredits(ctx),
  ]);
  const reads: Read<unknown>[] = [
    plan,
    bucket,
    rate,
    retention,
    invoices,
    credits,
  ];
  const failures = reads.filter((read): read is Failed => !read.ok);
  const denied = failures.find((read) => read.reason === "denied");
  if (denied !== undefined && denied.reason === "denied") {
    return (
      <BillingDenied
        org={ctx.orgName}
        permission={denied.permission}
        name={viewerName}
        role={ctx.orgRole}
      />
    );
  }
  const pending = failures.find((read) => read.reason === "pending_approval");
  if (pending !== undefined && pending.reason === "pending_approval") {
    return <BillingPending request={pending.accessRequestId} />;
  }
  // A failure of any read the design draws from is the error state: the
  // tiles are rollups of the lines, so a page missing one read cannot
  // reconcile.
  if (!plan.ok || !bucket.ok || !rate.ok || !retention.ok || !invoices.ok) {
    // A refusal or a waiting request returned above, so this is an error.
    const failed = [plan, bucket, rate, retention, invoices].find(
      (read): read is ReadError => !read.ok && read.reason === "error",
    );
    return (
      <BillingError
        code={failed?.code ?? "unknown"}
        status={failed?.status ?? 500}
        at={traceTime(instantAfterRead())}
        retry={routes.billing(ctx.orgSlug)}
      />
    );
  }

  const buys = buysFor(ctx);
  const banner = <CheckoutBanner outcome={checkoutOutcome(checkout)} />;

  const empty =
    plan.value.subscription === null &&
    bucket.value.usedGau === 0 &&
    bucket.value.purchasedGau === 0 &&
    cursor === null &&
    invoices.value.items.length === 0;
  if (empty) {
    return (
      <Page state="empty">
        {banner}
        <BillingEmpty />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <PurchaseForm
            org={ctx.orgSlug}
            bucket={bucket}
            rate={rate}
            maxGau={PURCHASE_GAU_MAX}
            allowed={buys}
          />
        </div>
      </Page>
    );
  }

  let blocked: PlanChangeBlock | null = null;
  if (!buys) blocked = { kind: "role" };
  else if (plan.value.subscription !== null)
    blocked = {
      kind: "subscribed",
      plan: plan.value.subscription.plan,
      tier: rate.value.tier,
    };
  const statement = statementFor({
    bucket: bucket.value,
    rate: rate.value,
    retention: retention.value,
    // No store records the onboarding offer yet (spec §20, deferred; #3845).
    discount: null,
  });
  return (
    <Page state="loaded">
      <Header
        title={title}
        org={ctx.orgName}
        action={
          <ChangePlan
            org={ctx.orgSlug}
            plans={PLAN_OPTIONS}
            blocked={blocked}
          />
        }
      />
      {banner}
      <SummaryTiles
        plan={plan.value}
        rate={rate.value}
        retention={retention.value}
        statement={statement}
        periodEnd={bucket.value.period.end}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ThisPeriod statement={statement} retention={retention.value} />
          <Meters bucket={bucket.value} retention={retention.value} />
          <Invoices
            invoices={invoices.value}
            cursor={cursor}
            org={ctx.orgSlug}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PriceList retention={retention.value} />
          <BillableUnits />
          <PaymentControls
            ctx={ctx}
            bucket={bucket}
            rate={rate}
            credits={credits}
            buys={buys}
          />
        </div>
      </div>
    </Page>
  );
}

/** The page's h1 with its eyebrow, the one-sentence subtext and Change plan. */
function Header({
  title,
  org,
  action,
}: {
  title: string;
  org: string;
  action: ReactNode;
}) {
  const t = useTranslations("billing.header");
  return (
    <PageHeader
      title={title}
      eyebrow={t("eyebrow")}
      description={t("description", { org })}
      actions={action}
    />
  );
}

function Page({
  state,
  children,
}: {
  state: "loaded" | "empty";
  children: ReactNode;
}) {
  return (
    <div data-page-state={state} className="flex flex-col gap-4">
      {children}
    </div>
  );
}
