// The Spend page's figures (#2962). A cost prints its money beside the basis
// the rollup recorded; a figure the rollup did not record prints "not
// recorded"; nothing prints a zero it was not given (ARCHITECTURE.md INV-09,
// INV-10). Money goes through <Money>, counts and ratios through
// src/ui/money-format.ts.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Cost, Money as MoneyValue } from "@/data/contracts/money";
import type { DayRange, SpendFigure } from "@/data/contracts/spend";
import { panel } from "@/ui/control-styles";
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
    <div className={`${panel} flex flex-col gap-1 p-4`}>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="font-mono text-2xl font-semibold tabular-nums">
        {children}
      </dd>
      {note === undefined ? null : (
        <dd className="text-xs text-muted-foreground">{note}</dd>
      )}
    </div>
  );
}

export function TileStrip({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</dl>
  );
}

/** Recorded spend and workload, without outcome or operator scores. */
export function SpendStrip({
  total,
  period,
}: {
  total: SpendFigure;
  period: DayRange;
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
      <Tile term={t("strip.coverage")} note={t("strip.coverageNote")}>
        {total.cost === null ? t("strip.missing") : t("strip.available")}
      </Tile>
    </TileStrip>
  );
}
