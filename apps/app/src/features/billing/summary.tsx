// The four tiles at the top of Billing (pages/billing.md, "Summary tiles"):
// the plan, the governed actions past the included allowance this period,
// the evidence retained, and what is due at the period's end. Each prints one
// figure and one basis line, and each figure is a rollup of a section below
// it: the governed actions and the amount due are statement.ts's, the same
// derivation This period prints, and the retained evidence is the figure the
// Retained evidence meter prints. One of the files money renders in (INV-25):
// the block price in the governed-action basis and the amount due.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ContractRate,
  EvidenceRetention,
  PlanCard,
} from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import {
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { BillingReadFailure } from "./read-failure";
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
      {rate.ok ? (
        t(`tiers.${rate.value.tier}`)
      ) : (
        <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>
      )}
    </Tile>
  );
}

function GovernedTile({ statement }: { statement: Read<Statement> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const term = t("tiles.governed");
  if (!statement.ok) {
    return (
      <Tile name="governed" term={term} note={null}>
        <BillingReadFailure read={statement} section={term} />
      </Tile>
    );
  }
  const s = statement.value;
  return (
    <Tile
      name="governed"
      term={term}
      data-count={s.aboveIncluded}
      note={t.rich("tiles.governedNote", {
        basis: () => <ChargeBasis charge={s.charge} included={s.includedGau} />,
      })}
    >
      {formatCount(s.aboveIncluded, locale)}
    </Tile>
  );
}

function RetainedTile({ retention }: { retention: Read<EvidenceRetention> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const term = t("tiles.retained");
  if (!retention.ok) {
    return (
      <Tile name="retained" term={term} note={null}>
        <BillingReadFailure read={retention} section={term} />
      </Tile>
    );
  }
  const r = retention.value;
  return (
    <Tile
      name="retained"
      term={term}
      note={t("tiles.retainedNote", {
        months: formatCount(r.includedMonths, locale),
      })}
    >
      <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>
    </Tile>
  );
}

function DueTile({
  statement,
  periodEnd,
}: {
  statement: Read<Statement>;
  /** The bucket month's end, when the bucket was read. */
  periodEnd: string | null;
}) {
  const t = useTranslations("billing");
  const date = useDate();
  const term = t("tiles.due", {
    date: periodEnd === null ? t("notRecorded") : date(periodEnd),
  });
  if (!statement.ok) {
    return (
      <Tile name="due" term={term} note={null}>
        <BillingReadFailure read={statement} section={term} />
      </Tile>
    );
  }
  const s = statement.value;
  return (
    <Tile
      name="due"
      term={term}
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
  plan: Read<PlanCard>;
  rate: Read<ContractRate>;
  retention: Read<EvidenceRetention>;
  statement: Read<Statement>;
  periodEnd: string | null;
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
