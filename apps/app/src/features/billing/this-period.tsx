// This period (pages/billing.md): the statement for the bucket month, one line
// each for the governed actions the meter priced, tokens, evidence retention
// and the onboarding discount, then the total. The figures are statement.ts's,
// the same derivation the tiles print, so the tiles are rollups of these rows.
// The onboarding discount has no store yet (spec §20, deferred; #3845): its
// basis says so, its amount says "not recorded", and the total, the sum after
// the discount, says "not recorded" with it. The table carries the design's
// list controls (@/ui/list-table). One of the files money renders in (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { EvidenceRetention } from "@/data/contracts/billing";
import type { Money as MoneyValue } from "@/data/contracts/money";
import { Badge } from "@/ui/badge";
import { type ListRow, ListTable } from "@/ui/list-table";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { cell } from "@/ui/table";
import { NotRecordedValue, Section } from "./section";
import type { GovernedCharge, Statement } from "./statement";

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

export function ThisPeriod({
  statement,
  retention,
}: {
  statement: Statement;
  retention: EvidenceRetention;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const title = t("thisPeriod.title");
  const badge = <Badge tone="quiet">{t("thisPeriod.badge")}</Badge>;
  const s = statement;
  const r = retention;
  const count = (n: number) => formatCount(n, locale);
  const notRecorded = <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>;
  const line = (
    name: string,
    cells: ListRow["cells"],
    strong = false,
  ): ListRow => ({
    key: name,
    cells,
    data: { "data-line": name },
    className: strong ? "font-semibold" : undefined,
  });
  const rows: ListRow[] = [
    line("governed", [
      s.pricedCount > 0
        ? t("thisPeriod.lines.governed", { count: count(s.pricedCount) })
        : t("thisPeriod.lines.governedNone"),
      <ChargeBasis key="basis" charge={s.charge} included={s.includedGau} />,
      <Money key="amount" value={s.governedAmount} />,
    ]),
    line("tokens", [
      t("thisPeriod.lines.tokens"),
      t("thisPeriod.basis.tokens"),
      <Money key="amount" value={s.tokensAmount} />,
    ]),
    line("retention", [
      t("thisPeriod.lines.retention"),
      t(
        r.extendedRetentionEnabled
          ? "thisPeriod.basis.retentionExtended"
          : "thisPeriod.basis.retention",
        {
          months: count(r.includedMonths),
          held: t("thisPeriod.basis.heldNotRecorded"),
        },
      ),
      <StatementAmount key="amount" value={s.retentionAmount} />,
    ]),
    line("discount", [
      t("thisPeriod.lines.discount"),
      t("thisPeriod.basis.discount"),
      s.discountAmount === null ? (
        notRecorded
      ) : (
        <Money key="amount" value={s.discountAmount} />
      ),
    ]),
    line(
      "total",
      [
        t("thisPeriod.lines.total"),
        t("thisPeriod.basis.total"),
        s.total === null ? (
          notRecorded
        ) : (
          <span key="amount">
            <Money value={s.total} /> {s.currency.toUpperCase()}
          </span>
        ),
      ],
      true,
    ),
  ];
  return (
    <Section id="billing-this-period" title={title} badge={badge} flush>
      <ListTable
        label={title}
        columns={[
          { label: t("thisPeriod.columns.line") },
          {
            label: t("thisPeriod.columns.basis"),
            className: `${cell} font-normal text-muted-foreground`,
          },
          { label: t("thisPeriod.columns.amount"), numeric: true },
        ]}
        rows={rows}
      />
    </Section>
  );
}
