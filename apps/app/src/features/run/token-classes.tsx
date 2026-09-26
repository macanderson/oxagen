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
// Prompt composition would split the mean model request into conversation,
// context frames, tool definitions, steering and system. That split is not
// recorded (G3), so its meters draw empty tracks and say so. The facts under
// them are recorded or derived: the effective input price is the input
// classes' recorded cost over the input tokens.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type { RunCost } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, headCell, numericCell } from "@/ui/table";
import { type ClassPrices, classShare } from "./cost-figures";
import { type RunMetrics, TOKEN_CLASSES } from "./metrics";
import { Fact, Facts, Meter, NoValue, Note, Panel, PanelBody } from "./parts";

/**
 * `.grid.g2 { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,
 * minmax(320px,1fr)) }`: the two panels side by side, stacked when narrow.
 */
const pair =
  "grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]";
/** `table.narrow { min-width:0 }`: a table that fits a half-width panel. */
const narrowTable = "w-full min-w-0 border-collapse text-[13px]";
/** `.hr { height:1px; background:var(--border); margin:14px 0 }` */
const rule = "my-3.5 h-px border-0 bg-border";

/** Prompt composition's parts, each with the hue the mockup gives its meter. */
const PARTS = [
  { key: "conversation", hue: "bg-success" },
  { key: "context", hue: "bg-proven" },
  { key: "definitions", hue: "bg-info" },
  { key: "steering", hue: "bg-kind-rule" },
  { key: "system", hue: "bg-dim" },
] as const;

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
          <span className="font-mono text-[11px] text-dim">
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
            className="m-0 max-w-prose text-[12.5px] text-muted-foreground"
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
                    data-class="server_tool_request"
                  >
                    <td className={`${cell} ${mono}`}>server_tool_request</td>
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

function PromptComposition({
  metrics,
  prices,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
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
  return (
    <Panel
      title={t("title")}
      testId="prompt-composition"
      aside={
        perModelCall === null ? undefined : (
          <span className="font-mono text-[11px] text-dim">
            {t("tally", { count: formatCount(perModelCall, locale) })}
          </span>
        )
      }
    >
      <div className="grid gap-[11px]">
        {PARTS.map((part) => (
          <div key={part.key} data-testid="composition-part">
            <Meter
              label={t(`parts.${part.key}`)}
              value={<NoValue />}
              share={null}
              hue={part.hue}
            />
          </div>
        ))}
      </div>
      <p className="mb-0 mt-2.5 text-[11.5px] text-muted-foreground">
        {t("partsNote")}
      </p>
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
          {productiveRatio === null ? (
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
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
  cost: Read<RunCost>;
}) {
  return (
    <div className={pair}>
      <TokenClasses metrics={metrics} prices={prices} cost={cost} />
      <PromptComposition metrics={metrics} prices={prices} />
    </div>
  );
}
