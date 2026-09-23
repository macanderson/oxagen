// The four tiles at the top of Billing (pages/billing.md, "Summary tiles"):
// the plan, the governed actions priced this period (the count the first line
// of This period is labelled with, so the tile and the line always agree),
// the evidence retained, and what is due at the period's end. Each prints one
// figure and one basis line, and each figure is a rollup of a section below
// it: the governed actions and the amount due are statement.ts's, the same
// derivation This period prints, and the retained evidence is the figure the
// Retained evidence meter prints. What is due is the total after the
// onboarding discount, and the discount has no store yet (#3845), so the Due
// tile says "not recorded" under the design's basis rather than a sum that
// left the discount out. Its date is the period's end as an ISO day, the way
// the design prints it. One of the files money renders in (INV-25): the block
// price in the governed-action basis and the amount due.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ContractRate,
  EvidenceRetention,
  PlanCard,
} from "@/data/contracts/billing";
import {
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { NotRecordedValue, useDate } from "./section";
import type { Statement } from "./statement";
import { ChargeBasis, StatementAmount } from "./this-period";

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

function PlanTile({ plan, rate }: { plan: PlanCard; rate: ContractRate }) {
  const t = useTranslations("billing");
  const { subscription } = plan;
  // The tier the terms resolve to names the plan for a person. The basis is
  // how the subscription bills: yearly when Stripe says so, since printing
  // "monthly" over an annual plan would state a term the record contradicts.
  // With no subscription the plan is the tier the terms resolve to (Free, or
  // a negotiated Enterprise agreement), and nothing bills it.
  const note =
    subscription === null
      ? t("tiles.planNone")
      : subscription.billingInterval === "year"
        ? t("tiles.planYear")
        : t("tiles.planMonth");
  return (
    <Tile name="plan" term={t("tiles.plan")} note={note}>
      {t(`tiers.${rate.tier}`)}
    </Tile>
  );
}

function GovernedTile({ statement: s }: { statement: Statement }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  // The count the first line of This period is labelled with: one number in
  // both places, never a second derivation.
  return (
    <Tile
      name="governed"
      term={t("tiles.governed")}
      data-count={s.pricedCount}
      note={t.rich("tiles.governedNote", {
        basis: () => <ChargeBasis charge={s.charge} included={s.includedGau} />,
      })}
    >
      {formatCount(s.pricedCount, locale)}
    </Tile>
  );
}

function RetainedTile({ retention }: { retention: EvidenceRetention }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  return (
    <Tile
      name="retained"
      term={t("tiles.retained")}
      note={t("tiles.retainedNote", {
        months: formatCount(retention.includedMonths, locale),
      })}
    >
      <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>
    </Tile>
  );
}

function DueTile({
  statement: s,
  periodEnd,
}: {
  statement: Statement;
  /** The bucket month's end. */
  periodEnd: string;
}) {
  const t = useTranslations("billing");
  const date = useDate();
  return (
    <Tile
      name="due"
      term={t("tiles.due", { date: date(periodEnd) })}
      note={t("tiles.dueNote", { currency: s.currency.toUpperCase() })}
    >
      <StatementAmount value={s.total} />
    </Tile>
  );
}

export function SummaryTiles({
  plan,
  rate,
  retention,
  statement,
  periodEnd,
}: {
  plan: PlanCard;
  rate: ContractRate;
  retention: EvidenceRetention;
  statement: Statement;
  periodEnd: string;
}) {
  const t = useTranslations("billing");
  return (
    <dl aria-label={t("tiles.label")} className={statStrip}>
      <PlanTile plan={plan} rate={rate} />
      <GovernedTile statement={statement} />
      <RetainedTile retention={retention} />
      <DueTile statement={statement} periodEnd={periodEnd} />
    </dl>
  );
}
