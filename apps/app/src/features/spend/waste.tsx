// Wasted spend (#2962): money whose frames show it bought nothing, by cause,
// with the runs that prove each cause. Each cause is a pattern the rollup
// reads off the frames; the list grows with the findings lane (#2963).
import { useTranslations } from "next-intl";
import type { SpendWaste } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  CostFigure,
  CountFigure,
  RatioFigure,
  Tile,
  TileStrip,
} from "./figures";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

export function WasteSection({
  waste,
  at,
}: {
  waste: SpendWaste;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  return (
    <>
      <TileStrip>
        <Tile term={t("waste.wasted")}>
          <CostFigure cost={waste.wasted} />
        </Tile>
        <Tile term={t("waste.share")}>
          <RatioFigure ratio={waste.share} />
        </Tile>
        <Tile term={t("waste.runsWithWaste")}>
          <CountFigure count={waste.runsWithWaste} />
        </Tile>
        <Tile term={t("waste.largestCause")}>
          {waste.largestCause === null
            ? t("waste.noCause")
            : t(`waste.cause.${waste.largestCause}`)}
        </Tile>
      </TileStrip>
      <Panel id="spend-waste-causes" title={t("waste.byCause")}>
        {waste.causes.length === 0 ? (
          <Empty>{t("waste.none")}</Empty>
        ) : (
          <ul className="flex flex-col gap-4 p-4">
            {waste.causes.map((cause) => (
              <li
                key={cause.cause}
                data-cause={cause.cause}
                className="flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {t(`waste.cause.${cause.cause}`)}
                  </span>
                  <CostFigure cost={cause.wasted} />
                </div>
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">
                      {t("columns.runs")}
                    </dt>
                    <dd>
                      <CountFigure count={cause.runs} />
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <dt className="text-muted-foreground">
                      {t("waste.proof")}
                    </dt>
                    {cause.provingRuns.map((run) => (
                      <dd key={run}>
                        <SafeLink
                          to={routes.run(at.org, at.ws, run)}
                          className={`${linkText} ${mono}`}
                        >
                          {run}
                        </SafeLink>
                      </dd>
                    ))}
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
