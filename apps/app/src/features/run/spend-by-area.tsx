// Spend by area (pages/run.md, Cost; the mockup's `runSpendByArea` and
// `runAreas`): the run's cost split across what its tokens were spent on,
// seven areas, then the dearest tools, then how the split is read.
//
// Model output is the output and reasoning classes the rollup counts, at the
// cost it recorded for them. Tool calls is the tools' result tokens at the
// run's uncached input rate (#3892, ADR-199): an estimate of input the run's
// cost already counts, labelled estimate, and never money on top of it.
//
// Tool definitions and Context retrievals are the run's standing context
// (spec detector 2, #4537): the tokens of each source every call after the
// first re-sent, at the run's cache read rate, or its input rate when it read
// nothing from the cache. Context retrievals holds two sources, the context
// frames and the steering Oxagen injected, as the mockup's area does, and its
// title and the note name each. The recorder estimates the tokens, so each
// figure is labelled estimate. A source the recorder did not report stays
// absent, and an area none of whose sources was reported reads not recorded.
//
// The first prompt, the follow-ups, and the system prompt share the rest of
// the input, and how a request splits into them is not recorded. So each of
// them draws its meter with an empty track and "not recorded", and the note
// names the input total they share. A bar's width is its share of the priced
// total, never of the widest bar, so an area drawn alone is not drawn as the
// largest.
//
// Most expensive tools lists the tools by that same estimate, dearest first.
// A row rolled up before result tokens were recorded carries no tool cost, so
// the tools are listed by how often they ran, and the line under them says so.
import { useLocale, useTranslations } from "next-intl";
import {
  byMicrosDescending,
  type Money as MoneyValue,
  ratioOfMicros,
  sumMoney,
} from "@/data/contracts/money";
import type { RunCost, RunCostStandingContext } from "@/data/contracts/run";
import { eyebrowQuiet, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import type { ClassPrices } from "./cost-figures";
import type { RunMetrics } from "./metrics";
import { Meter, NoValue, Note, Panel, PanelBody } from "./parts";

/**
 * The six input areas, in the mockup's order. Tool calls is recorded
 * (#3892), and Context retrievals and Tool definitions are recorded when the
 * run reports its standing context (#4537).
 */
const INPUT_AREAS = [
  "initial",
  "followUp",
  "context",
  "definitions",
  "results",
  "system",
] as const;

/** How many tools Most expensive tools lists. */
const TOOL_ROWS = 8;

type ToolCost = NonNullable<RunCost["rollup"]>["byTool"][number];

type StandingSource = NonNullable<RunCostStandingContext["toolDefinitions"]>;

/** The sources in the order the note names them, with the area each falls in. */
const STANDING_PARTS = [
  ["toolDefinitions", "definitions"],
  ["steering", "context"],
  ["contextFrames", "context"],
] as const;

/** A standing context area: its re-sent tokens, and their estimated cost when the run was priced. */
type StandingArea = {
  tokens: number;
  cost: MoneyValue | null;
  /** The sources in the area the recorder reported. */
  parts: { source: (typeof STANDING_PARTS)[number][0]; tokens: number }[];
};

/**
 * The area's sources summed; null when the recorder reported none of them.
 * Every source is priced at the run's one rate, so the cost is null when any
 * reported source has none.
 */
function standingArea(
  context: RunCostStandingContext | null,
  area: "definitions" | "context",
): StandingArea | null {
  if (context === null) return null;
  const reported = STANDING_PARTS.flatMap(([source, inArea]) => {
    const figure: StandingSource | null = context[source];
    return inArea === area && figure !== null ? [{ source, figure }] : [];
  });
  if (reported.length === 0) return null;
  const costs = reported.flatMap(({ figure }) =>
    figure.cost === null ? [] : [figure.cost],
  );
  return {
    tokens: reported.reduce((sum, { figure }) => sum + figure.resentTokens, 0),
    cost: costs.length === reported.length ? sumMoney(costs) : null,
    parts: reported.map(({ source, figure }) => ({
      source,
      tokens: figure.resentTokens,
    })),
  };
}

/** A listed tool: its name, its calls, and its estimated cost when the rollup priced its results. */
type ListedTool = { name: string | null; calls: number; cost: MoneyValue | null };

/**
 * The tools as the panel lists them: by estimated cost when any tool has one,
 * dearest first and the unpriced after by calls, else the server's calls per
 * tool, most called first.
 */
function listedTools(
  byTool: readonly ToolCost[] | null,
  byCalls: readonly { name: string | null; calls: number }[],
): { tools: ListedTool[]; priced: boolean } {
  const priced = (byTool ?? []).some((tool) => tool.cost !== null);
  if (!priced || byTool === null)
    return {
      tools: byCalls.map((tool) => ({ ...tool, cost: null })),
      priced: false,
    };
  const tools = [...byTool].sort((a, b) => {
    if (a.cost === null) return b.cost === null ? b.calls - a.calls : 1;
    if (b.cost === null) return -1;
    return byMicrosDescending(a.cost, b.cost) || b.calls - a.calls;
  });
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      calls: tool.calls,
      cost: tool.cost,
    })),
    priced: true,
  };
}

/**
 * `.rs-file { display:flex; justify-content:space-between; gap:10px;
 * padding:5px 0; border-bottom:1px solid var(--border); font-size:11.5px }`
 */
const toolRow =
  "flex min-w-0 justify-between gap-2.5 border-b border-border py-[5px] text-xs last:border-b-0";

/** `.meter .lab b .dim { font-weight:500 }`: the token count beside an area's money. */
const areaTokens = "font-medium text-dim";

export function SpendByArea({
  metrics,
  prices,
  byTool,
  standingContext,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  /** The rollup's per-tool calls, result tokens and estimated cost; null before the rollup. */
  byTool: readonly ToolCost[] | null;
  /** The context every call after the first re-sent, by source; null when no source was reported. */
  standingContext: RunCostStandingContext | null;
}) {
  const t = useTranslations("run.cost.area");
  const tCost = useTranslations("run.cost");
  const locale = useLocale();
  const { cost, tokens } = metrics;
  const output = prices.output;
  const outputShare =
    output === null || prices.total === null
      ? null
      : ratioOfMicros(output, prices.total);
  // By estimated cost when the rollup priced the results, else the server's
  // calls per tool, most called first (ADR-182).
  const { tools, priced } = listedTools(
    byTool,
    metrics.toolCalls?.tools ?? [],
  );
  // The Tool calls area is the tools' estimated costs summed; null when none
  // was priced or they span currencies.
  const results = sumMoney(
    (byTool ?? []).flatMap((tool) => (tool.cost === null ? [] : [tool.cost])),
  );
  const resultsShare =
    results === null || prices.total === null
      ? null
      : ratioOfMicros(results, prices.total);
  const standing = {
    definitions: standingArea(standingContext, "definitions"),
    context: standingArea(standingContext, "context"),
  };
  // Tool definitions, then steering, then context frames, as the finding
  // names them.
  const standingParts = [
    ...(standing.definitions?.parts ?? []),
    ...(standing.context?.parts ?? []),
  ];
  const split = (parts: StandingArea["parts"]) =>
    new Intl.ListFormat(locale, { type: "conjunction" }).format(
      parts.map((part) => t(`sources.${part.source}`, { count: part.tokens })),
    );
  const meter = (area: (typeof INPUT_AREAS)[number]) => {
    if (area === "results" && results !== null)
      return (
        <Meter
          label={t(`areas.${area}`)}
          title={t("resultsTitle")}
          value={
            <>
              <Money value={results} />{" "}
              <span className={areaTokens}>· {t("estimate")}</span>
            </>
          }
          share={resultsShare}
          hue="bg-info"
        />
      );
    const figure =
      area === "definitions" || area === "context" ? standing[area] : null;
    if (figure !== null)
      return (
        <Meter
          label={t(`areas.${area}`)}
          title={t("standingTitle", { split: split(figure.parts) })}
          value={
            <>
              {figure.cost === null ? (
                <NoValue />
              ) : (
                <Money value={figure.cost} />
              )}{" "}
              <span className={areaTokens}>
                · {t("tok", { count: formatCount(figure.tokens, locale) })} ·{" "}
                {t("estimate")}
              </span>
            </>
          }
          share={
            figure.cost === null || prices.total === null
              ? null
              : ratioOfMicros(figure.cost, prices.total)
          }
          hue="bg-info"
        />
      );
    return (
      <Meter
        label={t(`areas.${area}`)}
        value={<NoValue />}
        share={null}
        hue="bg-info"
      />
    );
  };
  return (
    <Panel
      title={t("title")}
      testId="spend-by-area"
      flush
      aside={
        cost === null ? undefined : (
          <span className="font-mono text-xs text-dim">
            <Money value={cost} /> · {cost.basis ?? tCost("basisNotRecorded")}
            {/* An open run's figure grows as it records calls (#3980). */}
            {metrics.costIsEstimate ? (
              <span data-testid="run-spend-estimate"> · {t("estimate")}</span>
            ) : null}
          </span>
        )
      }
    >
      <PanelBody>
        <div className="grid gap-[9px]">
          {INPUT_AREAS.map((area) => (
            <div key={area} data-testid="area-row" data-area={area}>
              {meter(area)}
            </div>
          ))}
          <div data-testid="area-row" data-area="output">
            <Meter
              label={t("areas.output")}
              title={
                tokens === null
                  ? undefined
                  : t("outputTitle", {
                      reasoning: formatCount(tokens.byClass.reasoning, locale),
                    })
              }
              value={
                tokens === null ? (
                  <NoValue />
                ) : (
                  <>
                    {output === null ? <NoValue /> : <Money value={output} />}{" "}
                    <span className={areaTokens}>
                      ·{" "}
                      {t("tok", { count: formatCount(tokens.output, locale) })}
                    </span>
                  </>
                )
              }
              share={outputShare}
              hue="bg-info"
            />
          </div>
        </div>
      </PanelBody>
      <PanelBody rule>
        <p className={`${eyebrowQuiet} mb-1 mt-0`}>{t("dearest")}</p>
        {tools.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            {metrics.toolCalls === null ? t("toolsNotRead") : t("noTools")}
          </p>
        ) : (
          <>
            <ul className="m-0 list-none p-0">
              {tools.slice(0, TOOL_ROWS).map((tool) => (
                <li
                  // The server lists each name once, and at most one row of
                  // calls whose record named no tool.
                  key={tool.name ?? ""}
                  data-testid="dearest-tool"
                  className={toolRow}
                >
                  <span
                    className={`${mono} min-w-0 truncate`}
                    data-truncate=""
                  >
                    {tool.name ?? t("unnamedTool")}
                  </span>
                  <span className="whitespace-nowrap font-mono text-dim">
                    {t("calls", { count: tool.calls })} ·{" "}
                    {tool.cost === null ? (
                      <NoValue />
                    ) : (
                      <span className="text-foreground">
                        <Money value={tool.cost} />
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p
              data-testid="dearest-tools-note"
              className="mb-0 mt-2 text-xs text-muted-foreground"
            >
              {priced ? t("byCost") : t("byCalls")}
            </p>
          </>
        )}
      </PanelBody>
      <PanelBody rule>
        <Note testId="area-note">
          {tokens === null
            ? t("noteNotRolledUp")
            : standingParts.length > 0
              ? t.rich("noteWithStanding", {
                  input: formatCount(tokens.input, locale),
                  split: split(standingParts),
                  results: results === null ? "no" : "yes",
                  cost: () =>
                    prices.input === null ? (
                      <NoValue />
                    ) : (
                      <Money value={prices.input} />
                    ),
                })
              : t.rich(results === null ? "note" : "noteWithResults", {
                  input: formatCount(tokens.input, locale),
                  cost: () =>
                    prices.input === null ? (
                      <NoValue />
                    ) : (
                      <Money value={prices.input} />
                    ),
                })}
        </Note>
      </PanelBody>
    </Panel>
  );
}
