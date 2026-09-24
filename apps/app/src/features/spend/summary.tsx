// The four summary tiles over every Spend tab (spec "Summary tiles"; hidden
// on a drill): Spend with its basis and currency, the month's tokens with the
// share served from cache, the share of tokens the gateway observed, and the
// wasted spend in the critical ink. Each is a rollup of the rows beneath it:
// Spend is the model rollup's total, the Total row of By model; Tokens is the
// sum of the model rows' classes, the By token class total.
import { useLocale, useTranslations } from "next-intl";
import type { SpendReport, SpendWaste } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { statNote } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { BasisLabel, NotRecordedValue, Tile, TileStrip } from "./figures";
import { cacheHitRate, sumClasses, totalOf } from "./rollup";

export function SummaryTiles({
  month,
  waste,
}: {
  month: SpendReport;
  waste: Read<SpendWaste>;
}) {
  const t = useTranslations("spend.summary");
  const locale = useLocale();
  const classes = sumClasses(month.rows);
  const tokens = totalOf(classes);
  const cache = cacheHitRate(classes);
  const cost = month.total.cost;
  const wasted = waste.ok ? waste.value : null;
  return (
    <section aria-label={t("label")} data-testid="spend-summary">
      <TileStrip>
        <Tile term={t("spend")}>
          {cost === null ? <NotRecordedValue /> : <Money value={cost} />}
          <span className={`${statNote} flex flex-wrap gap-x-1`}>
            <BasisLabel basis={cost?.basis ?? null} />
            {cost === null ? null : (
              <span>{t("currency", { currency: cost.currency })}</span>
            )}
          </span>
        </Tile>
        <Tile
          term={t("tokens")}
          note={
            cache === null
              ? t("cacheNotRecorded")
              : t("cache", { share: formatRatio(cache, locale) })
          }
        >
          <span className="tabular-nums">{formatCount(tokens, locale)}</span>
        </Tile>
        <Tile term={t("observed")} note={t("observedNote")}>
          <NotRecordedValue />
        </Tile>
        <Tile
          term={t("wasted")}
          note={
            wasted?.share === null || wasted === null
              ? undefined
              : t("wastedShare", { share: formatRatio(wasted.share, locale) })
          }
        >
          {wasted === null || wasted.wasted === null ? (
            <NotRecordedValue />
          ) : (
            <span data-tone="critical" className="text-destructive">
              <Money value={wasted.wasted} />
            </span>
          )}
        </Tile>
      </TileStrip>
    </section>
  );
}
