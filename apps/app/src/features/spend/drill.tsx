// One operator's, agent's or tool's spend over its trailing window (#2962,
// spec §12.9): the total, the averages per call and per run, its share of the
// workspace's spend, spend by day, and the tools its runs called. A tool's
// drill carries counts and no money, since no frame prices a tool call, so its
// money figures print as not recorded.
import { useTranslations } from "next-intl";
import type { SpendDrill } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  CostFigure,
  CountFigure,
  MoneyFigure,
  RatioFigure,
  Tile,
  TileStrip,
} from "./figures";
import { Empty, HeaderCell, Panel } from "./tables";
import type { SpendAt } from "./view";

const cell = "px-4 py-2 text-left align-top";

export function DrillSection({
  drill,
  at,
}: {
  drill: SpendDrill;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {t(`drill.title.${drill.kind}`)}{" "}
          <span className={mono}>{drill.key}</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("period", drill.period)}
        </p>
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: drill.kind })}
          className={`${linkText} text-sm`}
        >
          {t("drill.back")}
        </SafeLink>
      </div>
      <TileStrip>
        <Tile term={t("strip.spend")}>
          <CostFigure cost={drill.total.cost} />
        </Tile>
        <Tile term={t("drill.perCall")}>
          <MoneyFigure money={drill.perCall} precision="exact" />
        </Tile>
        <Tile term={t("drill.perRun")}>
          <MoneyFigure money={drill.perRun} precision="exact" />
        </Tile>
        <Tile term={t("drill.share")}>
          <RatioFigure ratio={drill.share} />
        </Tile>
      </TileStrip>
      <Panel id="spend-drill-days" title={t("drill.byDay")}>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <HeaderCell>{t("drill.day")}</HeaderCell>
              <HeaderCell>{t("columns.spend")}</HeaderCell>
              <HeaderCell>{t("columns.calls")}</HeaderCell>
              <HeaderCell>{t("columns.runs")}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {drill.series.map((day) => (
              <tr key={day.day} data-day={day.day}>
                <th scope="row" className={`${cell} font-normal ${mono}`}>
                  {day.day}
                </th>
                <td className={cell}>
                  <CostFigure cost={day.cost} />
                </td>
                <td className={cell}>
                  <CountFigure count={day.calls} />
                </td>
                <td className={cell}>
                  <CountFigure count={day.runs} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel id="spend-drill-tools" title={t("drill.tools")}>
        {drill.tools.length === 0 ? (
          <Empty>{t("drill.toolsEmpty")}</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <HeaderCell>{t("groups.tool.key")}</HeaderCell>
                <HeaderCell>{t("columns.calls")}</HeaderCell>
                <HeaderCell>{t("columns.runs")}</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {drill.tools.map((tool) => (
                <tr key={tool.name} data-key={tool.name}>
                  <th scope="row" className={`${cell} font-normal ${mono}`}>
                    {tool.name}
                  </th>
                  <td className={cell}>
                    <CountFigure count={tool.calls} />
                  </td>
                  <td className={cell}>
                    <CountFigure count={tool.runs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
