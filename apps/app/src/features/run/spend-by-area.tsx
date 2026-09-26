// Spend by area (pages/run.md, Cost; the mockup's `runSpendByArea` and
// `runAreas`): the run's cost split across what its tokens were spent on,
// seven areas, then the dearest tools, then how the split is read.
//
// Two areas are recorded. Model output is the output and reasoning classes the
// rollup counts, at the cost it recorded for them. Tool calls is the tools'
// result tokens at the run's uncached input rate (#3892, ADR-199): an
// estimate of input the run's cost already counts, labelled estimate, and
// never money on top of it. The five other input areas (the first prompt, the
// follow-ups, the context Oxagen injected, the tool definitions and the system
// prompt) share the rest of the input, and how a request splits into them is
// not recorded (`cost.run_totals` carries no `tool_definition_tokens`,
// `context_frame_tokens` or `steering_tokens` yet, #3894). So each of them
// draws its meter with an empty track and "not recorded", and the note names
// the input total they share. A bar's width is its share of the priced total,
// never of the widest bar, so an area drawn alone is not drawn as the largest.
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
import type { RunCost } from "@/data/contracts/run";
import { eyebrowQuiet, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import type { ClassPrices } from "./cost-figures";
import type { RunMetrics } from "./metrics";
import { Meter, NoValue, Note, Panel, PanelBody } from "./parts";

/** The six input areas, in the mockup's order; only Tool calls is recorded (#3892). */
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
  "flex min-w-0 justify-between gap-2.5 border-b border-border py-[5px] text-[11.5px] last:border-b-0";

/** `.meter .lab b .dim { font-weight:500 }`: the token count beside an area's money. */
const areaTokens = "font-medium text-dim";

export function SpendByArea({
  metrics,
  prices,
  byTool,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  /** The rollup's per-tool calls, result tokens and estimated cost; null before the rollup. */
  byTool: readonly ToolCost[] | null;
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
  return (
    <Panel
      title={t("title")}
      testId="spend-by-area"
      flush
      aside={
        cost === null ? undefined : (
          <span className="font-mono text-[11px] text-dim">
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
              {area === "results" && results !== null ? (
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
              ) : (
                <Meter
                  label={t(`areas.${area}`)}
                  value={<NoValue />}
                  share={null}
                  hue="bg-info"
                />
              )}
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
          <p className="m-0 text-[12.5px] text-muted-foreground">
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
                    title={tool.name ?? t("unnamedTool")}
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
              className="mb-0 mt-2 text-[11.5px] text-muted-foreground"
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
