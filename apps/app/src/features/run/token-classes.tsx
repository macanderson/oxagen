// Spend by token class beside Prompt composition, the last row of the Cost
// tab (pages/run.md, Cost; the mockup's `costTab`).
//
// Spend by token class lists the six classes of spec §12.6 with the count and
// the cost the rollup recorded, summed over the models by `runMetrics`. The
// rollup priced each call at its own instant (ADR-060), so nothing here is
// priced by the page. Its total row is the stat row's Tokens figure and the
// Tokens instrument's, and its cost is the sum of the rows; the note sets it
// against the run's recorded cost, which the run row can carry on its own. A
// run that ran web searches gets one more row: its searches counted in
// requests, whose cost the total adds and whose count no token figure does.
//
// Prompt composition splits the run's prompt tokens into conversation,
// context, tool definitions, steering and system (#5295, `prompt-split.ts`).
// When the run recorded request windows, each part is its block summed over
// every window, as a share of the windows' prompt total. Without windows, the
// three sources the recorder measures on each call fill their parts as a
// share of the run's input tokens, and conversation and system are not
// recorded. A part nothing measured draws an empty track and says not
// recorded, never zero. The note under the meters says which source the
// parts came from and how many requests they cover. The facts under them are
// recorded or derived: the effective input price is the input classes'
// recorded cost over the input tokens.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type { RunCost, RunCostTokenSources } from "@/data/contracts/run";
import type { RunContext } from "@/data/contracts/run-context";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, headCell, numericCell } from "@/ui/table";
import { type ClassPrices, classShare } from "./cost-figures";
import { type RunMetrics, TOKEN_CLASSES } from "./metrics";
import { Fact, Facts, Meter, NoValue, Note, Panel, PanelBody } from "./parts";
import { type PromptPart, promptSplit, shareOf } from "./prompt-split";

/**
 * `.grid.g2 { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,
 * minmax(320px,1fr)) }`: the two panels side by side, stacked when narrow.
 */
const pair =
  "grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]";
/** `table.narrow { min-width:0 }`: a table that fits a half-width panel. */
const narrowTable = "w-full min-w-0 border-collapse text-sm";

/** The book's class for web searches, which are priced per request (#3721). */
const SEARCH_CLASS = "server_tool_request";
/** `.hr { height:1px; background:var(--border); margin:14px 0 }` */
const rule = "my-3.5 h-px border-0 bg-border";

/** Prompt composition's parts, each with the hue the mockup gives its meter. */
const PARTS = [
  { key: "conversation", hue: "bg-success" },
  { key: "context", hue: "bg-proven" },
  { key: "definitions", hue: "bg-info" },
  { key: "steering", hue: "bg-kind-rule" },
  { key: "system", hue: "bg-dim" },
] as const satisfies readonly { key: PromptPart; hue: string }[];

function TokenClasses({
  metrics,
  prices,
  cost,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  cost: Read<RunCost>;
}) {
  const t = useTranslations("run.cost");
  const locale = useLocale();
  const { tokens, priced, searches } = metrics;
  const count = (value: number) => formatCount(value, locale);
  const searchShare =
    searches === null || searches.cost === null || prices.total === null
      ? null
      : ratioOfMicros(searches.cost, prices.total);
  const recorded = metrics.cost;
  const entries = cost.ok ? (cost.value.rollup?.priceEntryIds ?? []) : [];
  return (
    <Panel
      title={t("classes.title")}
      testId="token-classes"
      flush
      aside={
        tokens === null ? undefined : (
          <span className="font-mono text-sm text-dim">
            {t("classes.tally", { count: count(tokens.total) })}
          </span>
        )
      }
    >
      {!cost.ok ? (
        <PanelBody>
          <ReadFailure read={cost} section={t("classes.title")} />
        </PanelBody>
      ) : tokens === null ? (
        <PanelBody>
          <p
            data-testid="cost-not-rolled-up"
            className="m-0 max-w-prose text-sm text-muted-foreground"
          >
            {t("notRolledUp")}
          </p>
        </PanelBody>
      ) : (
        <>
          <div className="min-w-0 overflow-x-auto">
            <table aria-label={t("classes.title")} className={narrowTable}>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={`${headCell} text-left`}>
                    {t("classes.columns.class")}
                  </th>
                  <th scope="col" className={`${headCell} text-right`}>
                    {t("classes.columns.tokens")}
                  </th>
                  <th scope="col" className={`${headCell} text-right`}>
                    {t("classes.columns.cost")}
                  </th>
                  <th scope="col" className={`${headCell} text-right`}>
                    {t("classes.columns.share")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {TOKEN_CLASSES.map((tokenClass) => {
                  const part = priced?.byClass[tokenClass] ?? null;
                  const share = classShare(priced, tokenClass, prices.total);
                  return (
                    <tr
                      key={tokenClass}
                      data-testid="token-class-row"
                      data-class={tokenClass}
                    >
                      <td className={`${cell} ${mono}`}>{tokenClass}</td>
                      <td className={numericCell}>
                        {count(tokens.byClass[tokenClass])}
                      </td>
                      <td className={numericCell}>
                        {part === null ? (
                          <NoValue />
                        ) : (
                          <Money value={part} precision="exact" />
                        )}
                      </td>
                      <td className={`${numericCell} text-dim`}>
                        {share === null ? (
                          <NoValue />
                        ) : (
                          formatRatio(share, locale)
                        )}
                      </td>
                    </tr>
                  );
                })}
                {/* Web searches bill per request (#3721): their cost is in
                    the total below, and their count stays out of every
                    token figure. */}
                {searches === null ? null : (
                  <tr
                    data-testid="token-class-searches"
                    data-class={SEARCH_CLASS}
                  >
                    <td className={`${cell} ${mono}`}>{SEARCH_CLASS}</td>
                    <td className={numericCell}>
                      {t("classes.searchRequests", {
                        count: searches.requests,
                      })}
                    </td>
                    <td className={numericCell}>
                      {searches.cost === null ? (
                        <NoValue />
                      ) : (
                        <Money value={searches.cost} precision="exact" />
                      )}
                    </td>
                    <td className={`${numericCell} text-dim`}>
                      {searchShare === null ? (
                        <NoValue />
                      ) : (
                        formatRatio(searchShare, locale)
                      )}
                    </td>
                  </tr>
                )}
                <tr data-testid="token-class-total" className="font-semibold">
                  <td className={cell}>{t("classes.total")}</td>
                  <td
                    data-testid="token-class-total-tokens"
                    className={numericCell}
                  >
                    {count(tokens.total)}
                  </td>
                  <td className={numericCell}>
                    {prices.total === null ? (
                      <NoValue />
                    ) : (
                      <Money value={prices.total} precision="exact" />
                    )}
                  </td>
                  <td className={`${numericCell} font-normal text-dim`}>
                    {prices.total === null ? (
                      <NoValue />
                    ) : (
                      formatRatio(1, locale)
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <PanelBody rule>
            <Note testId="token-class-note">
              {priced === null
                ? t("classes.noModels")
                : prices.total === null
                  ? t("classes.unpriced")
                  : priced.hasUnpriced
                    ? t("classes.incomplete")
                    : t("classes.priced")}{" "}
              {recorded === null
                ? null
                : t.rich("classes.recorded", {
                    cost: () => <Money value={recorded} />,
                    basis: recorded.basis ?? t("basisNotRecorded"),
                  })}{" "}
              {entries.length === 0
                ? null
                : t.rich("classes.entries", {
                    entries: () => (
                      <span className={mono}>{entries.join(", ")}</span>
                    ),
                  })}
            </Note>
          </PanelBody>
        </>
      )}
    </Panel>
  );
}

/**
 * The line under the meters: which source the parts came from and how many
 * requests they cover, or why there are none.
 */
function PartsNote({
  context,
  from,
}: {
  context: Read<RunContext>;
  from: "windows" | "sources" | null;
}) {
  const t = useTranslations("run.cost.composition");
  const read = context.ok ? context.value : null;
  const composition = read?.composition ?? null;
  if (from === "windows" && read !== null && composition !== null)
    return (
      <>
        {t("windowsNote", {
          requests: composition.requests,
          // Requests the sums leave out: a window with no prompt total, and
          // a call recorded with no window at all.
          others: composition.requestsWithoutTokens + read.unmeasured,
          complete: read.complete ? "yes" : "no",
        })}
      </>
    );
  if (from === "sources") return <>{t("sourcesNote")}</>;
  return <>{t("partsNote")}</>;
}

function PromptComposition({
  metrics,
  prices,
  graded,
  context,
  tokenSources,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  /** The rollup's advanced steps over its steps; null until it grades the run (#3984). */
  graded: { advanced: number; steps: number } | null;
  /** `get_run_context`: the run's composition over its request windows. */
  context: Read<RunContext>;
  /** The rollup's measured sources; the parts fall back to them without windows. */
  tokenSources: RunCostTokenSources | null;
}) {
  const t = useTranslations("run.cost.composition");
  const tCost = useTranslations("run.cost");
  const locale = useLocale();
  const { perModelCall, cost, productiveRatio, tokens } = metrics;
  const rate = prices.inputRate;
  const writes =
    tokens === null
      ? null
      : tokens.byClass.cache_write_5m + tokens.byClass.cache_write_1h;
  const split = promptSplit(
    context.ok ? context.value.composition : null,
    tokenSources,
    tokens?.input ?? null,
  );
  return (
    <Panel
      title={t("title")}
      testId="prompt-composition"
      aside={
        perModelCall === null ? undefined : (
          <span className="font-mono text-sm text-dim">
            {t("tally", { count: formatCount(perModelCall, locale) })}
          </span>
        )
      }
    >
      <div className="grid gap-[11px]">
        {PARTS.map((part) => {
          const value = split?.parts[part.key] ?? null;
          const share = shareOf(value, split?.whole ?? null);
          return (
            <div
              key={part.key}
              data-testid="composition-part"
              data-part={part.key}
            >
              <Meter
                label={t(`parts.${part.key}`)}
                value={
                  value === null ? (
                    <NoValue />
                  ) : share === null ? (
                    t("tok", { count: formatCount(value, locale) })
                  ) : (
                    t("tokShare", {
                      count: formatCount(value, locale),
                      share: formatRatio(share, locale),
                    })
                  )
                }
                share={share}
                hue={part.hue}
              />
            </div>
          );
        })}
      </div>
      {/* A failed read of the windows says so, rather than reading as a run
          that recorded none. */}
      {context.ok ? (
        <p
          data-testid="composition-note"
          className="mb-0 mt-2.5 text-sm text-muted-foreground"
        >
          <PartsNote context={context} from={split?.from ?? null} />
        </p>
      ) : (
        <div className="mt-2.5">
          <ReadFailure read={context} section={t("title")} />
        </div>
      )}
      <hr className={rule} />
      <Facts>
        <Fact label={t("effectivePrice")}>
          {rate === null ? (
            <NoValue />
          ) : (
            t.rich("effectiveValue", { rate: () => <Money value={rate} /> })
          )}
        </Fact>
        <Fact label={t("cacheWriteShare")}>
          {prices.cacheWriteShare === null || writes === null ? (
            <NoValue />
          ) : writes === 0 && prices.cacheWriteShare === 0 ? (
            t("nothingWritten", {
              share: formatRatio(prices.cacheWriteShare, locale),
            })
          ) : (
            formatRatio(prices.cacheWriteShare, locale)
          )}
        </Fact>
        <Fact label={t("basis")}>
          {cost === null ? (
            <NoValue />
          ) : cost.basis === null ? (
            tCost("basisNotRecorded")
          ) : (
            <>
              <span className={mono}>{cost.basis}</span>
              {" · "}
              {t(`basisWhy.${cost.basis}`)}
            </>
          )}
        </Fact>
        <Fact label={t("productive")}>
          {graded !== null ? (
            t("productiveSteps", {
              advanced: formatCount(graded.advanced, locale),
              steps: graded.steps,
              total: formatCount(graded.steps, locale),
            })
          ) : productiveRatio === null ? (
            <NoValue />
          ) : (
            t("productiveValue", {
              ratio: formatRatio(productiveRatio, locale),
            })
          )}
        </Fact>
      </Facts>
    </Panel>
  );
}

export function TokenClassesAndComposition({
  metrics,
  prices,
  cost,
  context,
  tokenSources,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  cost: Read<RunCost>;
  /** `get_run_context`, whose composition Prompt composition draws (#5295). */
  context: Read<RunContext>;
  /** `get_run_cost`'s measured prompt sources; null when none was measured. */
  tokenSources: RunCostTokenSources | null;
}) {
  const rollup = cost.ok ? cost.value.rollup : null;
  const advanced = rollup?.advancedSteps ?? null;
  return (
    <div className={pair}>
      <TokenClasses metrics={metrics} prices={prices} cost={cost} />
      <PromptComposition
        metrics={metrics}
        prices={prices}
        graded={
          rollup === null || advanced === null
            ? null
            : { advanced, steps: rollup.steps }
        }
        context={context}
        tokenSources={tokenSources}
      />
    </div>
  );
}
