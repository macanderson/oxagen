// Spend by area (pages/run.md, Cost; the mockup's `runSpendByArea` and
// `runAreas`): the run's cost split across what its tokens were spent on,
// seven areas, then the dearest tools, then how the split is read.
//
// One area is recorded: Model output is the output and reasoning classes the
// rollup counts, priced from the book. The six input areas (the first prompt,
// the follow-ups, the context Oxagen injected, the tool definitions, the tool
// results and the system prompt) share the input tokens, and how a request
// splits into them is not recorded (G3: `cost.run_totals` carries no
// `tool_definition_tokens`, `context_frame_tokens` or `steering_tokens` yet).
// So each input area draws its meter with an empty track and "not recorded",
// and the note names the input total they share. A bar's width is its share of
// the priced total, never of the widest bar, so an area drawn alone is not
// drawn as the largest.
//
// What each tool cost is not recorded either: a tool call carries no price,
// and apportioning the result tokens by wall clock (the mockup's rule) would
// be a guess. The tools are listed by how often they ran, and the line under
// them says so.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import { eyebrowQuiet, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import type { ClassPrices } from "./cost-figures";
import type { RunMetrics } from "./metrics";
import { Meter, NoValue, Note, Panel, PanelBody } from "./parts";

/** The six input areas, in the mockup's order; none is recorded yet (G3). */
const INPUT_AREAS = [
  "initial",
  "followUp",
  "context",
  "definitions",
  "results",
  "system",
] as const;

/** How many tools Dearest tools lists. */
const TOOL_ROWS = 8;

/**
 * `.rs-file { display:flex; justify-content:space-between; gap:10px;
 * padding:5px 0; border-bottom:1px solid var(--border); font-size:11.5px }`
 */
const toolRow =
  "flex min-w-0 justify-between gap-2.5 border-b border-border py-[5px] text-[11.5px] last:border-b-0";

/** `.meter .lab b .dim { font-weight:500 }`: the token count beside an area's money. */
const areaTokens = "font-medium text-dim";

type ToolTally = { name: string; calls: number };

function tallyTools(metrics: RunMetrics): ToolTally[] {
  const by = new Map<string, number>();
  for (const call of metrics.toolCalls ?? [])
    by.set(call.name, (by.get(call.name) ?? 0) + 1);
  return [...by.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function SpendByArea({
  metrics,
  prices,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
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
  const tools = tallyTools(metrics);
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
              <Meter
                label={t(`areas.${area}`)}
                value={<NoValue />}
                share={null}
                hue="bg-info"
              />
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
                  key={tool.name}
                  data-testid="dearest-tool"
                  className={toolRow}
                >
                  <span
                    className={`${mono} min-w-0 truncate`}
                    title={tool.name}
                  >
                    {tool.name}
                  </span>
                  <span className="whitespace-nowrap font-mono text-dim">
                    {t("calls", { count: tool.calls })} · <NoValue />
                  </span>
                </li>
              ))}
            </ul>
            <p className="mb-0 mt-2 text-[11.5px] text-muted-foreground">
              {t("byCalls")}
            </p>
          </>
        )}
      </PanelBody>
      <PanelBody rule>
        <Note testId="area-note">
          {tokens === null
            ? t("noteNotRolledUp")
            : t.rich("note", {
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
