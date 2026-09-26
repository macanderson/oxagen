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
import type { UnmeteredRuns } from "@/data/contracts/spend";
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

/**
 * The basis a cost carries, in the record's own words (`gateway_observed`,
 * `client_attested`), never a stronger one: `mixed` reads as both.
 */
export function BasisLabel({ basis }: { basis: Cost["basis"] }) {
  const t = useTranslations("spend");
  return (
    <span
      data-basis={basis ?? "not_recorded"}
      className="font-mono text-[11px] font-normal text-muted-foreground"
    >
      {basis === null ? t("basisNotRecorded") : t(`basis.${basis}`)}
    </span>
  );
}

export function CostFigure({ cost }: { cost: Cost | null }) {
  if (cost === null) return <NotRecordedValue />;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <Money value={cost} />
      <BasisLabel basis={cost.basis} />
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

/**
 * The runs a total counts and leaves out of its cost, because no frame
 * reported what they spent, with the harness that ran them (#3304). Nothing
 * when every run reported usage, or the read did not say.
 */
export function UnmeteredNote({
  unmetered,
  className,
  testId,
}: {
  unmetered: UnmeteredRuns | undefined;
  className: string;
  testId: string;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  if (unmetered === undefined || unmetered.total === 0) return null;
  return (
    <span className={className} data-testid={testId}>
      {t("unmetered", {
        count: unmetered.total,
        harnesses: unmetered.byHarness
          .map((row) => `${row.harness} ${formatCount(row.runs, locale)}`)
          .join(", "),
      })}
    </span>
  );
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
