// This period (pages/billing.md): the statement for the bucket month, one line
// each for the governed actions past the included allowance, the plan when
// the organization has a subscription, tokens, evidence retention and the
// onboarding discount, then the total. The figures are statement.ts's, the
// same derivation the tiles print, so the tiles are rollups of these rows.
// The onboarding discount has no store yet (spec §20, deferred): its amount
// says "not recorded" and nothing is subtracted for it. One of the files money
// renders in (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { EvidenceRetention } from "@/data/contracts/billing";
import type { Money as MoneyValue } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import { Money } from "@/ui/money";
import { formatByteSize, formatCount } from "@/ui/money-format";
import { cell, numericCell, Table } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { NotRecordedValue, Section } from "./section";
import type { GovernedCharge, Statement } from "./statement";

type Failed = Exclude<Read<unknown>, { ok: true }>;

/** The governed-action line's basis: how the meter was priced. */
export function ChargeBasis({
  charge,
  included,
}: {
  charge: GovernedCharge;
  included: number;
}) {
  const t = useTranslations("billing.chargeBasis");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  switch (charge.kind) {
    case "blocks":
      return t.rich("blocks", {
        blocks: count(charge.blocks),
        included: count(included),
        price: () => <Money value={charge.blockPrice} />,
      });
    case "bought":
      return t.rich("bought", {
        count: count(charge.count),
        included: count(included),
        rate: () => <Money value={charge.rate} precision="exact" />,
      });
    case "overage":
      return t.rich("overage", {
        count: count(charge.count),
        included: count(included),
        rate: () => <Money value={charge.rate} precision="exact" />,
      });
  }
}

/** A statement amount, or "not recorded" when the statement could not say. */
export function StatementAmount({ value }: { value: MoneyValue | null }) {
  const t = useTranslations("billing");
  if (value === null) {
    return <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>;
  }
  return <Money value={value} />;
}

/** How much evidence the organization holds, or that nothing has measured it. */
export function useHeld(): (retention: EvidenceRetention) => string {
  const t = useTranslations("billing.thisPeriod.basis");
  const locale = useLocale();
  return (retention) =>
    retention.storedGb === null
      ? t("heldNotRecorded")
      : t("held", {
          size: formatByteSize(Math.round(retention.storedGb * 1e9), locale),
        });
}

function Line({
  name,
  line,
  basis,
  amount,
  strong = false,
}: {
  name: string;
  line: ReactNode;
  basis: ReactNode;
  amount: ReactNode;
  strong?: boolean;
}) {
  return (
    <tr data-line={name} className={strong ? "font-semibold" : undefined}>
      <td className={cell}>{line}</td>
      <td className={`${cell} font-normal text-muted-foreground`}>{basis}</td>
      <td className={numericCell}>{amount}</td>
    </tr>
  );
}

export function ThisPeriod({
  statement,
  retention,
}: {
  /** The statement, or the read that stopped it. */
  statement: Read<Statement>;
  retention: Read<EvidenceRetention>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const held = useHeld();
  const title = t("thisPeriod.title");
  const badge = <Badge tone="quiet">{t("thisPeriod.badge")}</Badge>;
  const failed = (read: Failed) => (
    <Section id="billing-this-period" title={title} badge={badge}>
      <BillingReadFailure read={read} section={title} />
    </Section>
  );
  if (!statement.ok) return failed(statement);
  if (!retention.ok) return failed(retention);
  const s = statement.value;
  const r = retention.value;
  const count = (n: number) => formatCount(n, locale);
  return (
    <Section id="billing-this-period" title={title} badge={badge} flush>
      <Table
        label={title}
        columns={[
          { label: t("thisPeriod.columns.line") },
          { label: t("thisPeriod.columns.basis") },
          { label: t("thisPeriod.columns.amount"), numeric: true },
        ]}
      >
        <Line
          name="governed"
          line={
            s.aboveIncluded > 0
              ? t("thisPeriod.lines.governed", {
                  count: count(s.aboveIncluded),
                })
              : t("thisPeriod.lines.governedNone")
          }
          basis={<ChargeBasis charge={s.charge} included={s.includedGau} />}
          amount={<Money value={s.governedAmount} />}
        />
        {s.plan === null ? null : (
          <Line
            name="plan"
            line={t("thisPeriod.lines.plan")}
            basis={t("thisPeriod.basis.plan", {
              plan: s.plan.subscription.plan,
              interval: t(`intervals.${s.plan.subscription.billingInterval}`),
              count: s.plan.invoices,
            })}
            amount={<StatementAmount value={s.plan.amount} />}
          />
        )}
        <Line
          name="tokens"
          line={t("thisPeriod.lines.tokens")}
          basis={t("thisPeriod.basis.tokens")}
          amount={<Money value={s.tokensAmount} />}
        />
        <Line
          name="retention"
          line={t("thisPeriod.lines.retention")}
          basis={t(
            r.extendedRetentionEnabled
              ? "thisPeriod.basis.retentionExtended"
              : "thisPeriod.basis.retention",
            { months: count(r.includedMonths), held: held(r) },
          )}
          amount={<StatementAmount value={s.retentionAmount} />}
        />
        <Line
          name="discount"
          line={t("thisPeriod.lines.discount")}
          basis={t("thisPeriod.basis.discount")}
          amount={<NotRecordedValue>{t("notRecorded")}</NotRecordedValue>}
        />
        <Line
          name="total"
          strong
          line={t("thisPeriod.lines.total")}
          basis={t("thisPeriod.basis.total")}
          amount={
            s.total === null ? (
              <StatementAmount value={null} />
            ) : (
              <span>
                <Money value={s.total} /> {s.currency.toUpperCase()}
              </span>
            )
          }
        />
      </Table>
    </Section>
  );
}
