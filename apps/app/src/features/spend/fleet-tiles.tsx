// Fleet's two spend tiles (#2962; ARCHITECTURE.md §1.2 Fleet row): Spend today
// with the basis the rollup recorded, and the cache hit rate over today's model
// calls, both from one get_spend read at the model level. A tile whose read
// failed is not drawn, as WL-34 draws its own tiles; a figure the rollup did
// not record prints "not recorded", never a zero.
import "server-only";
import { useTranslations } from "next-intl";
import type { DayRange, FleetSpend } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { CostFigure, RatioFigure, Tile, TileStrip } from "./figures";
import { dayOf } from "./view";

type FleetSpendTilesProps = {
  ctx: WsCtx;
  source: DataSource;
  /** Today in UTC; the clock when absent. */
  today?: Date;
  embedded?: boolean;
};

/**
 * Spend today and Cache hit rate, as two tiles. No page draws them since
 * Fleet's rev1 rebuild (#3928) sums its own rows.
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export async function FleetSpendTiles({
  ctx,
  source,
  today,
  embedded = false,
}: FleetSpendTilesProps) {
  const period = dayOf(today);
  const read = await source.spend.fleet(ctx, period);
  return read.ok ? (
    <FleetSpendStrip spend={read.value} period={period} embedded={embedded} />
  ) : null;
}

function FleetSpendStrip({
  spend,
  period,
  embedded,
}: {
  spend: FleetSpend;
  period: DayRange;
  embedded: boolean;
}) {
  const t = useTranslations("spend");
  return (
    <section
      aria-label={t("fleet.label")}
      data-testid="fleet-spend"
      className={embedded ? "contents" : undefined}
    >
      <TileStrip embedded={embedded}>
        <Tile
          term={t("fleet.spendToday")}
          note={t("fleet.spendTodayNote", { from: period.from })}
        >
          <CostFigure cost={spend.spend} />
        </Tile>
        <Tile term={t("fleet.cacheHitRate")} note={t("fleet.cacheHitRateNote")}>
          <RatioFigure ratio={spend.cacheHitRate} />
        </Tile>
      </TileStrip>
    </section>
  );
}
