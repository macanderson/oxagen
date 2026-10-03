// One operator's, agent's or tool's spend over its trailing window (#2962,
// #5293; spec "Drill"): the crumb back to its table, the header with Open the
// agent (an agent only) and Export this view, the potential savings its own
// findings hold, the kind's stat tiles, spend by day as a chart with its peak
// and average, the cross-cuts, and its findings. get_spend_drill answers every
// figure the tiles and the cross-cuts draw: the totals, the averages, the
// series, the tokens and their cache hit rate, the model calls, the part the
// gateway metered, the standing context, the tool results, the tools its runs
// called, and its spend by agent, operator and model. A tile prints "not
// recorded" only where the response carries null or no source records the
// figure yet (wasted, budget, trend, and a tool's repeat calls and retries).
// A tool's spend is what its results cost as input to later calls, an
// estimate its runs already paid, and the page says so. The per-key report
// behind Export this view waits on a contract that takes a key. An agent
// carries its avatar with the harness it registered (#4871).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { divMicros, maxMoney, ratioOfMicros } from "@/data/contracts/money";
import type {
  DrillCutRow,
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
import { type AgentHarnesses, AgentMark, harnessIn } from "./agent-mark";
import {
  BasisLabel,
  CostFigure,
  MoneyFigure,
  NotRecordedValue,
  RatioFigure,
  Tile,
  TileStrip,
  UnmeteredNote,
} from "./figures";
import { GAP_ISSUE, NotBacked } from "./not-backed";
import { classesOf, findingsOn, savingOf, sumCost, totalOf } from "./rollup";
import { SpendByDayChart } from "./spend-by-day-chart";
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

type Cut = "agent" | "operator" | "model";

/** The cross-cuts each kind draws, besides By tool on an operator or an agent. */
const CROSS_CUTS: Record<SpendDrillKind, readonly Cut[]> = {
  operator: ["agent", "model"],
  agent: ["operator", "model"],
  tool: ["agent", "operator"],
};

/** The response field each cross-cut reads. */
const CUT_ROWS = {
  agent: "byAgent",
  operator: "byOperator",
  model: "byModel",
} as const satisfies Record<Cut, keyof SpendDrill>;

/** A count the response carried, or "not recorded" where it carried null. */
function CountValue({ count }: { count: number | null }) {
  const locale = useLocale();
  return count === null ? (
    <NotRecordedValue />
  ) : (
    <span className="tabular-nums">{formatCount(count, locale)}</span>
  );
}

/**
 * One tile: its figure, and a note where the figure needs one. A tool's
 * spend and cache hit rate say what they cover, since the first is an
 * estimate and the second is its runs' rate. A figure no source records yet
 * prints "not recorded".
 */
function DrillTile({ tile, drill }: { tile: TileKey; drill: SpendDrill }) {
  const t = useTranslations("spend.drill");
  const isTool = drill.kind === "tool";
  let value: ReactNode;
  let note: string | undefined;
  switch (tile) {
    case "spend":
      value = <CostFigure cost={drill.total.cost} />;
      if (isTool) note = t("toolSpendNote");
      break;
    case "tokens":
      value = <CountValue count={totalOf(classesOf(drill.tokens))} />;
      break;
    case "cacheHit":
      value = <RatioFigure ratio={drill.cacheHitRate} />;
      if (isTool && drill.cacheHitRate !== null) note = t("toolCacheNote");
      break;
    case "observed": {
      const share =
        drill.observed === null || drill.total.cost === null
          ? null
          : ratioOfMicros(drill.observed, drill.total.cost);
      value = <RatioFigure ratio={share} />;
      if (share !== null) note = t("observedNote");
      break;
    }
    case "productive":
      value = <RatioFigure ratio={drill.total.productiveRatio} />;
      break;
    case "runs":
      value = <CountValue count={drill.total.runs} />;
      break;
    case "modelCalls":
      value = <CountValue count={drill.modelCalls} />;
      break;
    case "calls":
      value = <CountValue count={drill.total.calls} />;
      break;
    case "perRun":
    case "avgPerRun":
      value = <MoneyFigure money={drill.perRun} precision="exact" />;
      break;
    case "perCall":
      value = <MoneyFigure money={drill.perCall} precision="exact" />;
      break;
    case "toolDefinitions":
      value = <CountValue count={drill.standing.toolDefinitionTokens} />;
      if (drill.standing.toolDefinitionTokens !== null)
        note = t("toolDefinitionsNote");
      break;
    case "resultBody":
      value = <CountValue count={drill.resultTokens} />;
      if (drill.resultTokens !== null) note = t("resultBodyNote");
      break;
    default:
      // Wasted, budgets, trend, and a tool's repeat calls and retries: no
      // source records them per key yet.
      value = <NotRecordedValue />;
  }
  return (
    <Tile term={t(`tiles.${tile}`)} note={note}>
      {value}
    </Tile>
  );
}

/**
 * Spend by day: an area over the window, with its peak and average. A window
 * with no priced day says so instead of drawing an empty chart. A tool's days
 * are its results' estimate, and the footer says what that is.
 */
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
          {drill.kind === "tool" ? (
            <span className="basis-full" data-testid="spend-drill-estimate">
              {t("toolEstimate")}
            </span>
          ) : null}
        </span>
      }
    >
      {peak === null ? (
        <Empty>{t("noPricedDay")}</Empty>
      ) : (
        <SpendByDayChart
          series={drill.series}
          peak={peak}
          label={t("sparkline", {
            from: drill.period.from,
            to: drill.period.to,
          })}
        />
      )}
    </Panel>
  );
}

/** A cross-cut row's name: the agent with its avatar, the person, or the model and its provider. */
function CutName({
  cut,
  row,
  at,
  harnesses,
}: {
  cut: Cut;
  row: DrillCutRow;
  at: SpendAt;
  harnesses: AgentHarnesses;
}) {
  switch (cut) {
    case "agent":
      return (
        <span className="flex min-w-0 items-center gap-2">
          <AgentMark
            agentKey={row.key}
            harness={harnessIn(harnesses, row.key)}
          />
          <SafeLink
            to={routes.spend(at.org, at.ws, { tab: "agent", drill: row.key })}
            className={`${linkText} ${mono} break-all`}
          >
            {row.key}
          </SafeLink>
        </span>
      );
    case "operator": {
      // A principal nobody can name is shown by its key, never a made-up name.
      const person = row.operator?.name ?? null;
      return (
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: "operator", drill: row.key })}
          className={person === null ? `${linkText} ${mono}` : linkText}
        >
          {person ?? row.key}
        </SafeLink>
      );
    }
    case "model":
      return (
        <span className="flex min-w-0 flex-col">
          <span className={`${mono} break-all`}>{row.key}</span>
          {row.provider === null ? null : (
            <span className="text-sm text-muted-foreground">
              {row.provider}
            </span>
          )}
        </span>
      );
  }
}

/**
 * One cross-cut as a table. On an operator or agent drill a row is its runs'
 * calls, tokens and spend; on a tool drill it is the tool's calls, result
 * tokens and result cost in those runs.
 */
function CutPanel({
  cut,
  drill,
  at,
  harnesses,
}: {
  cut: Cut;
  drill: SpendDrill;
  at: SpendAt;
  harnesses: AgentHarnesses;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const rows = drill[CUT_ROWS[cut]];
  const isTool = drill.kind === "tool";
  const title = t(`drill.cross.${cut}`);
  return (
    <Panel id={`spend-drill-${cut}`} title={title}>
      {rows.length === 0 ? (
        <Empty>{t(`drill.cutEmpty.${cut}`)}</Empty>
      ) : (
        <Table
          label={title}
          columns={[
            { label: t(`drill.columns.${cut}`) },
            { label: t("columns.runs"), numeric: true },
            { label: t("columns.calls"), numeric: true },
            {
              label: isTool
                ? t("drill.columns.resultTokens")
                : t("drill.columns.tokens"),
              numeric: true,
            },
            {
              label: isTool ? t("drill.columns.resultCost") : t("columns.spend"),
              numeric: true,
            },
          ]}
        >
          {rows.map((row) => (
            <tr key={row.key} data-key={row.key}>
              <th scope="row" className={`${cell} text-left font-normal`}>
                <CutName cut={cut} row={row} at={at} harnesses={harnesses} />
              </th>
              <td className={numericCell}>{formatCount(row.runs, locale)}</td>
              <td className={numericCell}>{formatCount(row.calls, locale)}</td>
              <td className={numericCell}>
                <CountValue
                  count={
                    isTool ? row.resultTokens : totalOf(classesOf(row.tokens))
                  }
                />
              </td>
              <td className={numericCell}>
                <CostFigure cost={row.cost} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/** By tool on an operator's or an agent's drill: each tool's calls, runs, result tokens and their cost. */
function ToolsPanel({ drill, at }: { drill: SpendDrill; at: SpendAt }) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel
      id="spend-drill-tools"
      title={t("drill.cross.tool")}
      footer={drill.tools.length === 0 ? undefined : t("drill.toolEstimate")}
    >
      {drill.tools.length === 0 ? (
        <Empty>{t("drill.toolsEmpty")}</Empty>
      ) : (
        <Table
          label={t("drill.cross.tool")}
          columns={[
            { label: t("columns.tool") },
            { label: t("columns.calls"), numeric: true },
            { label: t("columns.runs"), numeric: true },
            { label: t("drill.columns.resultTokens"), numeric: true },
            { label: t("drill.columns.resultCost"), numeric: true },
          ]}
        >
          {drill.tools.map((tool) => (
            <tr key={tool.name} data-key={tool.name}>
              <th
                scope="row"
                className={`${cell} text-left font-mono font-normal`}
              >
                <SafeLink
                  to={routes.spend(at.org, at.ws, {
                    tab: "tool",
                    drill: tool.name,
                  })}
                  className={`${linkText} break-all`}
                >
                  {tool.name}
                </SafeLink>
              </th>
              <td className={numericCell}>{formatCount(tool.calls, locale)}</td>
              <td className={numericCell}>{formatCount(tool.runs, locale)}</td>
              <td className={numericCell}>
                <CountValue count={tool.resultTokens} />
              </td>
              <td className={numericCell}>
                <CostFigure cost={tool.cost} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function DrillSection({
  drill,
  findings,
  operator,
  at,
  harness = null,
  harnesses = {},
}: {
  drill: SpendDrill;
  findings: readonly SpendFinding[] | null;
  operator: Operator;
  at: SpendAt;
  /** An agent drill's registered harness; null for another kind or none. */
  harness?: string | null;
  /** Each agent's registered harness, by key, for the By agent table's avatars. */
  harnesses?: AgentHarnesses;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const kindLabel = t(`drill.kind.${drill.kind}`);
  // An operator drill names the person: the month's operator row when the
  // page read it, else the drill's own By operator row for the key.
  const ownFacts =
    drill.byOperator.find((row) => row.key === drill.key)?.operator ?? null;
  const name =
    drill.kind === "operator"
      ? (operator?.name ?? ownFacts?.name ?? drill.key)
      : drill.key;
  const own =
    findings === null ? null : findingsOn(findings, drill.kind, drill.key);
  const saving = own === null ? null : savingOf(own);
  // The crumb goes back to where the key's drill is reached: By tool for a
  // tool, the operator ranking on Findings for an operator (the v3 mockup's
  // operator review), and the Month tab grouped by agent for an agent.
  const back =
    drill.kind === "tool"
      ? {
          to: routes.spend(at.org, at.ws, { tab: "tool" }),
          label: t("tabs.tool"),
        }
      : drill.kind === "operator"
        ? {
            to: routes.spend(at.org, at.ws, { tab: "findings" }),
            label: t("tabs.findings"),
          }
        : {
            to: routes.spend(at.org, at.ws, { tab: "month" }),
            label: t("month.by.titles.agent"),
          };
  return (
    <>
      <nav aria-label={t("drill.crumbLabel")} className="text-sm">
        <SafeLink to={back.to} className={linkText}>
          {t("drill.crumb", { tab: back.label })}
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
          {drill.kind === "agent" ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <AgentMark agentKey={drill.key} harness={harness} size={28} />
              <h2 className={`text-lg font-semibold ${mono} break-all`}>
                {name}
              </h2>
            </span>
          ) : (
            <h2
              className={`text-lg font-semibold ${drill.kind === "operator" ? "" : `${mono} break-all`}`}
            >
              {name}
            </h2>
          )}
          <p className="text-sm text-muted-foreground">
            {t("drill.counts", {
              runs: formatCount(drill.total.runs, locale),
              calls: formatCount(drill.total.calls, locale),
              from: drill.period.from,
              to: drill.period.to,
            })}
          </p>
          <UnmeteredNote
            unmetered={drill.unmeteredRuns}
            className="block text-sm text-muted-foreground"
            testId="spend-drill-unmetered"
          />
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
        <span className="text-sm text-muted-foreground">
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
          <DrillTile key={tile} tile={tile} drill={drill} />
        ))}
      </TileStrip>
      <SpendByDay drill={drill} />
      <div className="grid gap-3.5 xl:grid-cols-2">
        {drill.kind === "tool" ? null : (
          <div className="min-w-0 xl:col-span-2">
            <ToolsPanel drill={drill} at={at} />
          </div>
        )}
        {CROSS_CUTS[drill.kind].map((cut) => (
          <div key={cut} className="min-w-0">
            <CutPanel cut={cut} drill={drill} at={at} harnesses={harnesses} />
          </div>
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
                  <span className="text-sm text-muted-foreground">
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
        <p className="text-sm text-muted-foreground">
          {t("drill.share", { share: formatRatio(drill.share, locale) })}
        </p>
      )}
    </>
  );
}
