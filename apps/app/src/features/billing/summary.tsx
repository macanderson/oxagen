// The four tiles at the top of Billing (pages/billing.md, "Summary tiles"):
// the plan, this month's governed action units, the contracted rate and what
// is due. Each prints one figure and one basis line, and each figure is a
// rollup of a section below it — the bucket in Meters, the terms in the price
// list, the open rows of Invoices — never a number typed twice. One of the
// files money renders in (INV-25): the rate per 1,000 GAU and the open total.
import { statNote, statTerm, statTile, statValue } from "@/ui/control-styles";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ContractRate,
  GauBucket,
  InvoicePage,
  PlanCard,
} from "@/data/contracts/billing";
import { mulMicros, sumMoney } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { BillingReadFailure } from "./read-failure";
import { useDate } from "./section";

function Tile({
  name,
  term,
  note,
  children,
  ...data
}: {
  name: string;
  term: string;
  note: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string | number>) {
  return (
    <div data-tile={name} className={statTile} {...data}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{children}</dd>
      <dd className={statNote}>{note}</dd>
    </div>
  );
}

function PlanTile({
  plan,
  rate,
}: {
  plan: Read<PlanCard>;
  rate: Read<ContractRate>;
}) {
  const t = useTranslations("billing");
  const term = t("tiles.plan");
  if (!plan.ok) {
    return (
      <Tile name="plan" term={term} note={null}>
        <BillingReadFailure read={plan} section={term} />
      </Tile>
    );
  }
  const { subscription } = plan.value;
  if (subscription !== null) {
    return (
      <Tile
        name="plan"
        term={term}
        note={
          subscription.billingInterval === "year"
            ? t("tiles.planYear")
            : t("tiles.planMonth")
        }
      >
        {subscription.plan}
      </Tile>
    );
  }
  // No subscription: the tier the terms resolve to names the plan (Free, or a
  // negotiated Enterprise agreement).
  return (
    <Tile name="plan" term={term} note={t("tiles.planNone")}>
      {rate.ok ? t(`tiers.${rate.value.tier}`) : t("notRecorded")}
    </Tile>
  );
}

function GauTile({ bucket }: { bucket: Read<GauBucket> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const term = t("tiles.gau");
  if (!bucket.ok) {
    return (
      <Tile name="gau" term={term} note={null}>
        <BillingReadFailure read={bucket} section={term} />
      </Tile>
    );
  }
  const b = bucket.value;
  const count = (n: number) => formatCount(n, locale);
  return (
    <Tile
      name="gau"
      term={term}
      data-remaining={b.remainingGau}
      note={t("tiles.gauNote", {
        used: count(b.usedGau),
        included: count(b.includedGau),
        purchased: count(b.purchasedGau),
        carried: count(b.carriedGau),
      })}
    >
      {b.remainingGau < 0
        ? t("tiles.overdrawn", { count: count(-b.remainingGau) })
        : count(b.remainingGau)}
    </Tile>
  );
}

function RateTile({ rate }: { rate: Read<ContractRate> }) {
  const t = useTranslations("billing");
  const date = useDate();
  const term = t("tiles.rate");
  if (!rate.ok) {
    return (
      <Tile name="rate" term={term} note={null}>
        <BillingReadFailure read={rate} section={term} />
      </Tile>
    );
  }
  const r = rate.value;
  let source: string;
  if (r.source === "published_tier")
    source = t("rate.published", { tier: t(`tiers.${r.tier}`) });
  else if (r.agreementRef === null) source = t("rate.negotiatedNoRef");
  else source = t("rate.negotiated", { ref: r.agreementRef });
  return (
    <Tile
      name="rate"
      term={term}
      data-block-size={r.blockSizeGau}
      data-source={r.source}
      note={`${source} · ${date(r.effectiveFrom)}`}
    >
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        <Money value={mulMicros(r.ratePerGau, 1000)} />
        <span className="text-xs font-normal text-muted-foreground">
          {t("tiles.perThousand")}
        </span>
      </span>
    </Tile>
  );
}

function DueTile({
  invoices,
  bucket,
}: {
  invoices: Read<InvoicePage>;
  bucket: Read<GauBucket>;
}) {
  const t = useTranslations("billing");
  const date = useDate();
  const term = t("tiles.due");
  if (!invoices.ok) {
    return (
      <Tile name="due" term={term} note={null}>
        <BillingReadFailure read={invoices} section={term} />
      </Tile>
    );
  }
  const open = invoices.value.items.filter((row) => row.status === "open");
  if (open.length === 0) {
    return (
      <Tile
        name="due"
        term={term}
        note={
          bucket.ok
            ? t("tiles.nextInvoice", { date: date(bucket.value.period.end) })
            : null
        }
      >
        {t("tiles.nothingDue")}
      </Tile>
    );
  }
  const total = sumMoney(open.map((row) => row.amountDue));
  return (
    <Tile
      name="due"
      term={term}
      data-open={open.length}
      note={
        total === null
          ? t("tiles.mixedCurrency")
          : t("tiles.dueNote", {
              count: open.length,
              currency: total.currency.toUpperCase(),
            })
      }
    >
      {total === null ? t("notRecorded") : <Money value={total} />}
    </Tile>
  );
}

export function SummaryTiles({
  plan,
  bucket,
  rate,
  invoices,
}: {
  plan: Read<PlanCard>;
  bucket: Read<GauBucket>;
  rate: Read<ContractRate>;
  /** The newest invoices page, whatever page the Invoices section shows. */
  invoices: Read<InvoicePage>;
}) {
  const t = useTranslations("billing");
  return (
    <dl
      aria-label={t("tiles.label")}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <PlanTile plan={plan} rate={rate} />
      <GauTile bucket={bucket} />
      <RateTile rate={rate} />
      <DueTile invoices={invoices} bucket={bucket} />
    </dl>
  );
}
