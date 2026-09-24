// The Spend page's figures (#2962). A cost prints its money beside the basis
// the rollup recorded; a figure the rollup did not record prints "not
// recorded"; nothing prints a zero it was not given (ARCHITECTURE.md INV-09,
// INV-10). Money goes through <Money>, counts and ratios through
// src/ui/money-format.ts.
import {
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Cost, Money as MoneyValue } from "@/data/contracts/money";
import type { DayRange, SpendFigure } from "@/data/contracts/spend";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import type { MoneyPrecision } from "@/ui/money-format";
import { formatCount, formatRatio } from "@/ui/money-format";

/** An instant a contract carried, as a date in the viewer's locale. */
export function Instant({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso}>
      {format.dateTime(new Date(iso), { dateStyle: "medium" })}
    </time>
  );
}

export function NotRecordedValue() {
  const t = useTranslations("spend");
  return (
    <span data-recorded="false" className="text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
}

export function CostFigure({ cost }: { cost: Cost | null }) {
  const t = useTranslations("spend");
  if (cost === null) return <NotRecordedValue />;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <Money value={cost} />
      <span
        data-basis={cost.basis ?? "not_recorded"}
        className="font-mono text-xs font-normal text-muted-foreground"
      >
        {cost.basis === null ? t("basisNotRecorded") : t(`basis.${cost.basis}`)}
      </span>
    </span>
  );
}

/** Pricing provenance for a potential saving, separate from the estimate. */
export function EstimateBasis({ cost }: { cost: Cost | null }) {
  const t = useTranslations("spend");
  if (cost === null) return null;
  return (
    <span
      data-estimate-basis={cost.basis ?? "not_recorded"}
      className="block text-xs font-normal text-muted-foreground"
    >
      {t("findings.costData", {
        basis:
          cost.basis === null
            ? t("basisNotRecorded")
            : t(`basis.${cost.basis}`),
      })}
    </span>
  );
}

export function MoneyFigure({
  money,
  precision = "cents",
}: {
  money: MoneyValue | null;
  precision?: MoneyPrecision;
}) {
  return money === null ? (
    <NotRecordedValue />
  ) : (
    <Money value={money} precision={precision} />
  );
}

export function RatioFigure({ ratio }: { ratio: number | null }) {
  const locale = useLocale();
  return ratio === null ? (
    <NotRecordedValue />
  ) : (
    <span className="tabular-nums">{formatRatio(ratio, locale)}</span>
  );
}

export function CountFigure({ count }: { count: number }) {
  const locale = useLocale();
  return <span className="tabular-nums">{formatCount(count, locale)}</span>;
}

/** One tile of a figure strip: a term, its figure and an optional note. */
export function Tile({
  term,
  note,
  children,
}: {
  term: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{children}</dd>
      {note === undefined ? null : <dd className={statNote}>{note}</dd>}
    </div>
  );
}

export function TileStrip({
  children,
  embedded = false,
}: {
  children: ReactNode;
  embedded?: boolean;
}) {
  return <dl className={embedded ? "contents" : statStrip}>{children}</dl>;
}

/** Recorded spend and workload, without outcome or operator scores. */
export function SpendStrip({
  total,
  period,
  estimatedRuns = 0,
}: {
  total: SpendFigure;
  period: DayRange;
  /** Open runs whose cost is in `total` as a running estimate. */
  estimatedRuns?: number;
}) {
  const t = useTranslations("spend");
  return (
    <TileStrip>
      <Tile term={t("strip.spend")} note={t("period", period)}>
        <CostFigure cost={total.cost} />
      </Tile>
      <Tile term={t("strip.runs")} note={t("strip.runsNote")}>
        <CountFigure count={total.runs} />
      </Tile>
      <Tile term={t("strip.calls")} note={t("strip.callsNote")}>
        <CountFigure count={total.calls} />
      </Tile>
      <Tile
        term={t("strip.coverage")}
        note={
          estimatedRuns > 0
            ? t("strip.estimatedNote", { count: estimatedRuns })
            : t("strip.coverageNote")
        }
      >
        {total.cost === null
          ? t("strip.missing")
          : estimatedRuns > 0
            ? t("strip.estimated")
            : t("strip.available")}
      </Tile>
    </TileStrip>
  );
}
