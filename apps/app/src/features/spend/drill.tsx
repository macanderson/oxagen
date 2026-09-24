// One operator's, agent's or tool's spend over its trailing window (#2962;
// spec "Drill"): the crumb back to its tab, the header with Open the agent (an
// agent only) and Export this view, the potential savings its own findings
// hold, the kind's stat tiles, spend by day as a sparkline with its peak and
// average, the cross-cuts, and its findings. get_spend_drill answers the
// totals, the averages, the series and the tools its runs called; every other
// tile the design draws prints "not recorded" until the rollup carries it
// (#2962), and the per-key report behind Export this view waits on a contract
// that takes a key.
import { useLocale, useTranslations } from "next-intl";
import { divMicros, maxMoney, ratioOfMicros } from "@/data/contracts/money";
import type {
  SpendDrill,
  SpendDrillKind,
  SpendFinding,
  SpendReport,
} from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import {
  buttonSecondary,
  eyebrow,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import {
  BasisLabel,
  CostFigure,
  MoneyFigure,
  NotRecordedValue,
  RatioFigure,
  Tile,
  TileStrip,
} from "./figures";
import { GAP_ISSUE, NotBacked, NotBackedPanel } from "./not-backed";
import { findingsOn, savingOf, sumCost } from "./rollup";
import { StubDialog } from "./stub-dialog";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

type Operator = SpendReport["rows"][number]["operator"];

type TileKey =
  | "spend"
  | "tokens"
  | "cacheHit"
  | "observed"
  | "wasted"
  | "productive"
  | "runs"
  | "modelCalls"
  | "budget"
  | "agentBudget"
  | "trend"
  | "toolDefinitions"
  | "perRun"
  | "calls"
  | "perCall"
  | "avgPerRun"
  | "resultBody"
  | "repeatCalls"
  | "retries";

/** Each kind's tiles, in the design's order. */
const TILES: Record<SpendDrillKind, readonly TileKey[]> = {
  operator: [
    "spend",
    "tokens",
    "cacheHit",
    "observed",
    "wasted",
    "productive",
    "runs",
    "modelCalls",
    "budget",
    "trend",
  ],
  agent: [
    "spend",
    "tokens",
    "cacheHit",
    "toolDefinitions",
    "wasted",
    "perRun",
    "productive",
    "modelCalls",
    "trend",
    "agentBudget",
  ],
  tool: [
    "spend",
    "calls",
    "perCall",
    "avgPerRun",
    "resultBody",
    "repeatCalls",
    "retries",
    "cacheHit",
    "wasted",
    "trend",
  ],
};

/** The cross-cuts each kind allows, besides By tool, which the drill answers. */
const CROSS_CUTS: Record<
  SpendDrillKind,
  readonly ("agent" | "operator" | "model")[]
> = {
  operator: ["agent", "model"],
  agent: ["operator", "model"],
  tool: ["agent", "operator"],
};

function TileValue({ tile, drill }: { tile: TileKey; drill: SpendDrill }) {
  const locale = useLocale();
  switch (tile) {
    case "spend":
      return <CostFigure cost={drill.total.cost} />;
    case "productive":
      return <RatioFigure ratio={drill.total.productiveRatio} />;
    case "runs":
      return <>{formatCount(drill.total.runs, locale)}</>;
    case "modelCalls":
    case "calls":
      return <>{formatCount(drill.total.calls, locale)}</>;
    case "perRun":
    case "avgPerRun":
      return <MoneyFigure money={drill.perRun} precision="exact" />;
    case "perCall":
      return <MoneyFigure money={drill.perCall} precision="exact" />;
    default:
      return <NotRecordedValue />;
  }
}

/** Spend by day: a sparkline over the window, with its peak and average. */
function SpendByDay({ drill }: { drill: SpendDrill }) {
  const t = useTranslations("spend.drill");
  const costs = drill.series.flatMap((day) =>
    day.cost === null ? [] : [day.cost],
  );
  const total = sumCost(costs);
  const peak = maxMoney(costs);
  const average = total === null ? null : divMicros(total, drill.series.length);
  const peakDay =
    peak === null
      ? null
      : (drill.series.find((day) => day.cost?.micros === peak.micros) ?? null);
  // The points are layout: each day's height is its share of the peak. A day
  // with no priced run sits on the baseline and is named in the table below.
  const width = 300;
  const height = 48;
  const step = drill.series.length > 1 ? width / (drill.series.length - 1) : 0;
  const points = drill.series
    .map((day, index) => {
      const ratio =
        day.cost === null || peak === null
          ? 0
          : (ratioOfMicros(day.cost, peak) ?? 0);
      return `${String(Math.round(index * step))},${String(Math.round(height - ratio * height))}`;
    })
    .join(" ");
  return (
    <Panel
      id="spend-drill-days"
      title={t("byDay")}
      footer={
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            {t("peak")} <MoneyFigure money={peak} />
            {peakDay === null ? null : ` ${t("on", { day: peakDay.day })}`}
          </span>
          <span>
            {t("average")} <MoneyFigure money={average} />
          </span>
          <BasisLabel basis={total?.basis ?? null} />
        </span>
      }
    >
      <div className="px-4 py-3.5">
        <svg
          role="img"
          aria-label={t("sparkline", {
            from: drill.period.from,
            to: drill.period.to,
          })}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          preserveAspectRatio="none"
          className="h-14 w-full text-gold"
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </Panel>
  );
}

export function DrillSection({
  drill,
  findings,
  operator,
  at,
}: {
  drill: SpendDrill;
  findings: readonly SpendFinding[] | null;
  operator: Operator;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const kindLabel = t(`drill.kind.${drill.kind}`);
  const name =
    drill.kind === "operator" ? (operator?.name ?? drill.key) : drill.key;
  const own =
    findings === null ? null : findingsOn(findings, drill.kind, drill.key);
  const saving = own === null ? null : savingOf(own);
  return (
    <>
      <nav aria-label={t("drill.crumbLabel")} className="text-[13px]">
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: drill.kind })}
          className={linkText}
        >
          {t("drill.crumb", { tab: t(`tabs.${drill.kind}`) })}
        </SafeLink>
        <span aria-hidden="true" className="px-1.5 text-muted-foreground">
          /
        </span>
        <span
          aria-current="page"
          className={drill.kind === "operator" ? "" : mono}
        >
          {name}
        </span>
      </nav>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={eyebrow}>{kindLabel}</p>
          <h2
            className={`text-lg font-semibold ${drill.kind === "operator" ? "" : `${mono} break-all`}`}
          >
            {name}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {t("drill.counts", {
              runs: formatCount(drill.total.runs, locale),
              calls: formatCount(drill.total.calls, locale),
              from: drill.period.from,
              to: drill.period.to,
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {drill.kind === "agent" ? (
            <SafeLink
              to={routes.agent(
                at.org,
                at.ws,
                drill.key.split(".").pop() ?? drill.key,
              )}
              className={buttonSecondary}
            >
              {t("drill.openAgent")}
            </SafeLink>
          ) : null}
          <StubDialog
            label={t("drill.export")}
            title={t("drill.exportTitle")}
            body={t("drill.exportBody", { kind: kindLabel.toLowerCase() })}
            issue={GAP_ISSUE.rollup}
            testId="spend-drill-export"
          />
        </div>
      </div>
      <section
        aria-labelledby="spend-drill-savings"
        className={`${panel} flex flex-col gap-2 px-5 py-4`}
      >
        <h3 id="spend-drill-savings" className={eyebrow}>
          {t("drill.savings")}
        </h3>
        <span className="text-3xl font-bold tabular-nums">
          {saving === null ? (
            own === null ? (
              <NotRecordedValue />
            ) : (
              <span className="text-muted-foreground">
                {t("drill.noSaving")}
              </span>
            )
          ) : (
            <Money value={saving} />
          )}
        </span>
        {saving === null ? null : <BasisLabel basis={saving.basis} />}
        <span className="text-[12.5px] text-muted-foreground">
          {own === null
            ? t("drill.findingsFailed")
            : t("drill.direct", {
                count: own.length,
                kind: kindLabel.toLowerCase(),
              })}
        </span>
        <NotBacked gap="findings">{t("drill.attributedMissing")}</NotBacked>
      </section>
      <TileStrip>
        {TILES[drill.kind].map((tile) => (
          <Tile key={tile} term={t(`drill.tiles.${tile}`)}>
            <TileValue tile={tile} drill={drill} />
          </Tile>
        ))}
      </TileStrip>
      <SpendByDay drill={drill} />
      <div className="grid gap-3.5 lg:grid-cols-3">
        {drill.kind === "tool" ? null : (
          <Panel id="spend-drill-tools" title={t("drill.cross.tool")}>
            {drill.tools.length === 0 ? (
              <Empty>{t("drill.toolsEmpty")}</Empty>
            ) : (
              <Table
                label={t("drill.cross.tool")}
                columns={[
                  { label: t("columns.tool") },
                  { label: t("columns.calls"), numeric: true },
                  { label: t("columns.runs"), numeric: true },
                ]}
              >
                {drill.tools.map((tool) => (
                  <tr key={tool.name} data-key={tool.name}>
                    <th
                      scope="row"
                      className={`${cell} text-left font-mono font-normal`}
                    >
                      {tool.name}
                    </th>
                    <td className={numericCell}>
                      {formatCount(tool.calls, locale)}
                    </td>
                    <td className={numericCell}>
                      {formatCount(tool.runs, locale)}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        )}
        {CROSS_CUTS[drill.kind].map((cut) => (
          <NotBackedPanel
            key={cut}
            id={`spend-drill-${cut}`}
            title={t(`drill.cross.${cut}`)}
            gap="rollup"
          >
            {t("drill.crossMissing")}
          </NotBackedPanel>
        ))}
      </div>
      <Panel id="spend-drill-findings" title={t("drill.findings")}>
        {own === null ? (
          <Empty>{t("drill.findingsFailed")}</Empty>
        ) : own.length === 0 ? (
          <Empty>{t("drill.noFindings")}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {own.map((finding) => (
              <li
                key={finding.id}
                data-finding={finding.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-semibold">
                    {t(`findings.kind.${finding.kind}`)}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {finding.why}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold">
                    <Money value={finding.saving} />
                  </span>
                  <SafeLink
                    to={routes.spend(at.org, at.ws, {
                      tab: "findings",
                      finding: finding.id,
                    })}
                    className={buttonSecondary}
                  >
                    {t("findings.evidence.open")}
                  </SafeLink>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {drill.share === null ? null : (
        <p className="text-[12px] text-muted-foreground">
          {t("drill.share", { share: formatRatio(drill.share, locale) })}
        </p>
      )}
    </>
  );
}
