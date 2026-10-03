// Spend by area (pages/run.md, Cost; the mockup's `runSpendByArea` and
// `runAreas`): the run's cost split across what its tokens were spent on,
// seven areas, then the dearest tools, then how the split is read.
//
// Model output is the output and reasoning classes the rollup counts, at the
// cost it recorded for them. Tool results is the tools' result tokens at the
// run's uncached input rate (#3892, ADR-199): an estimate of input the run's
// cost already counts, labelled estimate, and never money on top of it.
//
// Tool definitions and Context are the run's standing context when the
// recorder reported it (spec detector 2, #4537): the tokens of each source
// every call after the first re-sent, at the run's cache read rate, or its
// input rate when it read nothing from the cache. Context holds two sources,
// the context frames and the steering Oxagen injected, as the mockup's area
// does, and its title and the note name each.
//
// Prompt, Follow-up prompts and System come from the run's request windows
// (#5295, ADR-200), summed by `get_run_context` and split by `windowAreas`
// in `prompt-split.ts`. Prompt is the first request's conversation block,
// Follow-up prompts every later request's, and System every request's system
// block. Tool definitions and Context take the windows' tools, steering and
// context blocks when the standing context reported none for them. A window
// area's cost is its tokens' share of the run's input tokens times the input
// classes' recorded cost, so it apportions money the rollup recorded and
// prices nothing new. Every one of these figures is an estimate and says so,
// and its title says which record it came from.
//
// A source the recorder did not report stays absent, and an area none of
// whose sources was reported reads not recorded, never zero. A bar's width is
// its share of the priced total, never of the widest bar, so an area drawn
// alone is not drawn as the largest.
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
import type { ContextComposition } from "@/data/contracts/run-context";
import { eyebrowQuiet, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import type { ClassPrices } from "./cost-figures";
import type { RunMetrics } from "./metrics";
import { Meter, NoValue, Note, Panel, PanelBody } from "./parts";
import { inputCostOf, resultTokensOf, windowAreas } from "./prompt-split";

/**
 * The six input areas, in the mockup's order. Tool results is recorded
 * (#3892), Context and Tool definitions are recorded when the run reports
 * its standing context (#4537), and every area but Tool results is recorded
 * when the run recorded request windows (#5295).
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
  "flex min-w-0 justify-between gap-2.5 border-b border-border py-[5px] text-sm last:border-b-0";

/** `.meter .lab b .dim { font-weight:500 }`: the token count beside an area's money. */
const areaTokens = "font-medium text-dim";

export function SpendByArea({
  metrics,
  prices,
  byTool,
  standingContext,
  composition = null,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  /** The rollup's per-tool calls, result tokens and estimated cost; null before the rollup. */
  byTool: readonly ToolCost[] | null;
  /** The context every call after the first re-sent, by source; null when no source was reported. */
  standingContext: RunCostStandingContext | null;
  /** Each block summed over the run's request windows (#5295); null when it recorded none. */
  composition?: ContextComposition | null;
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
  // The Tool results area is the tools' estimated costs summed; null when
  // none was priced or they span currencies.
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
  const resultTokens = resultTokensOf(byTool);
  // The areas the request windows fill, in tokens (#5295).
  const windows = windowAreas(composition);
  const byWindows: Record<(typeof INPUT_AREAS)[number], number | null> = {
    initial: windows?.initial ?? null,
    followUp: windows?.followUp ?? null,
    context: windows?.context?.tokens ?? null,
    definitions: windows?.definitions ?? null,
    results: null,
    system: windows?.system ?? null,
  };
  // Context names the two blocks it holds, steering first, as the standing
  // context's title does.
  const windowSplit = () => {
    const held = windows?.context ?? null;
    const named: string[] = [];
    if (held !== null && held.steering !== null)
      named.push(t("sources.steering", { count: held.steering }));
    if (held !== null && held.context !== null)
      named.push(t("sources.contextBlock", { count: held.context }));
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(named);
  };
  // How the areas are read: the windows' split when the run recorded one,
  // else the standing context, else the input total the areas share.
  const note = () => {
    if (tokens === null) return t("noteNotRolledUp");
    const inputCost = () =>
      prices.input === null ? <NoValue /> : <Money value={prices.input} />;
    const input = formatCount(tokens.input, locale);
    const withResults = results === null ? "no" : "yes";
    if (composition !== null)
      return t.rich("noteWithWindows", {
        input,
        requests: composition.requests,
        standing: standingParts.length > 0 ? "yes" : "no",
        split: split(standingParts),
        results: withResults,
        cost: inputCost,
      });
    if (standingParts.length > 0)
      return t.rich("noteWithStanding", {
        input,
        split: split(standingParts),
        results: withResults,
        cost: inputCost,
      });
    return t.rich(results === null ? "note" : "noteWithResults", {
      input,
      cost: inputCost,
    });
  };
  const meter = (area: (typeof INPUT_AREAS)[number]) => {
    // The result tokens show when the spans recorded them, even where the
    // run has no input price to put on them.
    if (area === "results" && (results !== null || resultTokens !== null))
      return (
        <Meter
          label={t(`areas.${area}`)}
          title={t("resultsTitle")}
          value={
            <>
              {results === null ? <NoValue /> : <Money value={results} />}{" "}
              <span className={areaTokens}>
                {resultTokens === null
                  ? null
                  : `· ${t("tok", { count: formatCount(resultTokens, locale) })} `}
                · {t("estimate")}
              </span>
            </>
          }
          share={resultsShare}
          hue="bg-info"
        />
      );
    const figure =
      area === "definitions" || area === "context" ? standing[area] : null;
    // The standing context wins where it reported the area: it is the
    // recorder's own count. The windows fill the rest.
    const fromWindows = figure === null ? byWindows[area] : null;
    if (fromWindows !== null) {
      const areaCost = inputCostOf(
        fromWindows,
        prices.input,
        tokens?.input ?? null,
      );
      return (
        <Meter
          label={t(`areas.${area}`)}
          title={
            area === "context"
              ? t("windowsSplitTitle", { split: windowSplit() })
              : t("windowsTitle")
          }
          value={
            <>
              {areaCost === null ? <NoValue /> : <Money value={areaCost} />}{" "}
              <span className={areaTokens}>
                · {t("tok", { count: formatCount(fromWindows, locale) })} ·{" "}
                {t("estimate")}
              </span>
            </>
          }
          share={
            areaCost === null || prices.total === null
              ? null
              : ratioOfMicros(areaCost, prices.total)
          }
          hue="bg-info"
        />
      );
    }
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
          <span className="font-mono text-sm text-dim">
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
              className="mb-0 mt-2 text-sm text-muted-foreground"
            >
              {priced ? t("byCost") : t("byCalls")}
            </p>
          </>
        )}
      </PanelBody>
      <PanelBody rule>
        <Note testId="area-note">{note()}</Note>
      </PanelBody>
    </Panel>
  );
}
