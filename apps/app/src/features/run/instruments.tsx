// The six instruments across the top of the Cost tab (pages/run.md, Cost; the
// mockup's `runInstruments`): Cost so far, Wall clock, Tokens, Shape of the
// run, Tool calls and Productive ratio. Each tile is one figure, one line
// under it, a small chart and a foot.
//
// Every figure is read from `runMetrics` and from the per-turn ledger
// `cost-figures.ts` sums from `get_run_turns`, so the Tokens tile is the stat
// row's Tokens figure and the total row of Spend by token class, and the Shape
// tile's steps and frames are the waterfall's total row. What the record does not carry (this agent's
// median run, its 30-day productive ratio) is named as not recorded where the
// mockup draws a figure.
import { useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import { type Money, ratioOfIntegers } from "@/data/contracts/money";
import type { RunRow } from "@/data/contracts/runs";
import { Clock } from "@/ui/clock";
import { Money as MoneyText } from "@/ui/money";
import {
  formatCount,
  formatDuration,
  formatMoney,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { type ClassPrices, type Ledger, perTurn } from "./cost-figures";
import {
  type Family,
  type ProvisionalModel,
  type ProvisionalSpend,
  provisionalCost,
  type RunMetrics,
  type WallLead,
} from "./metrics";
import { NoValue } from "./parts";
import { ToolIcon } from "./tool-icon";

/**
 * `.inst-grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px }`
 * and `#viewport.phone .inst-grid { grid-template-columns:minmax(0,1fr) }`.
 */
const instGrid = "grid grid-cols-1 gap-3.5 md:grid-cols-3";
/**
 * `.inst { background:var(--panel); border:1px solid var(--border);
 * border-radius:12px; padding:13px 15px 12px; display:grid; gap:8px;
 * align-content:start }`
 */
const inst =
  "grid min-w-0 content-start gap-2 rounded-xl border border-border bg-card px-[15px] pb-3 pt-[13px] text-card-foreground";
/** `.inst .ih .k { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--dim); font-weight:600 }` */
const instKey =
  "m-0 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim";
/** `.inst .ih .basis { margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--dim) }` */
const instBasis = "ml-auto font-mono text-[10px] text-dim";
/** `.inst .iv { font-size:26px; font-weight:700; letter-spacing:-.02em; line-height:1.1 }` */
const instValue =
  "text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-foreground tabular-nums";
/** `.inst .iv small { font-size:12px; font-weight:500; color:var(--muted); letter-spacing:0; margin-left:6px }` */
const instUnit =
  "ml-1.5 text-xs font-medium tracking-normal text-muted-foreground";
/** `.inst .iv .sep { color:var(--dim); font-weight:400; margin:0 5px }` */
const instSep = "mx-[5px] font-normal text-dim";
/** `.inst .is { font-size:11.5px; color:var(--muted); line-height:1.45 }` and `.is b { color:var(--fg); font-weight:600 }` */
const instLine =
  "text-[11.5px] leading-[1.45] text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground";
/** `.cols { display:flex; align-items:flex-end; gap:2px; height:46px; padding-top:14px; position:relative }` */
const cols = "relative flex h-[46px] items-end gap-0.5 pt-3.5";
/** `.cols .c { flex:1; max-width:24px; height:100%; flex-direction:column; justify-content:flex-end; gap:2px }` */
const col = "relative flex h-full max-w-6 flex-1 flex-col justify-end gap-0.5";
/** `.cols .c i { border-radius:4px 4px 0 0; min-height:2px }`; a stacked second `i` is square. */
const colFill = "block min-h-0.5 w-full first:rounded-t";
/** `.cols .c .lab { bottom:calc(100% + 3px); font-family:var(--mono); font-size:10px; color:var(--muted) }` */
const colLabel =
  "absolute bottom-[calc(100%+3px)] left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground";
/** `.cols .c.cur::after`: the 4px dot under the column a live run is still adding to. */
const colCurrent =
  "after:absolute after:-bottom-1.5 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-foreground";
/** `.cols .base { height:1px; background:var(--border) }` */
const colBase = "absolute inset-x-0 bottom-0 h-px bg-border";
/** `.ax { justify-content:space-between; font-family:var(--mono); font-size:10px; color:var(--dim); margin-top:3px }` */
const axis =
  "mt-[3px] flex justify-between font-mono text-[10px] text-dim tabular-nums";
/** `.stk { display:flex; gap:2px; height:8px; border-radius:4px; margin-top:4px }`, its first and last `i` rounded. */
const stack = "relative mt-1 flex h-2 gap-0.5 rounded";
const stackPart = "block h-full min-w-0.5 first:rounded-l last:rounded-r";
/** `.leg { gap:10px; font-size:10.5px; color:var(--muted) }`, `.leg i { 9px; border-radius:2px }`, `.leg b { color:var(--fg) }` */
const legend =
  "flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground tabular-nums";
const legendSwatch = "size-[9px] flex-none rounded-[2px]";
/** `.fams { display:grid; gap:5px }` */
const families = "grid gap-[5px]";
/** `.frow { grid-template-columns:20px 1fr 34% auto; gap:8px; padding:2px 0; color:var(--body) }` */
const familyRow =
  "grid grid-cols-[20px_minmax(0,1fr)_34%_auto] items-center gap-2 py-0.5 text-foreground";
/** `.frow .ti { 20px; border-radius:5px; color:var(--tc,var(--muted)); background:<that at 14%> }` */
const familyIcon =
  "grid size-5 place-items-center rounded-[5px] bg-muted-foreground/15 text-muted-foreground";
/** `.frow .fl { font-size:11.5px; text-overflow:ellipsis }` */
const familyLabel = "min-w-0 truncate text-[11.5px]";
/** `.frow .fn { font-family:var(--mono); font-size:11px; color:var(--fg); min-width:18px; text-align:right }` */
const familyCount =
  "min-w-[18px] text-right font-mono text-[11px] tabular-nums text-foreground";
/** `.fb { height:7px; border-radius:4px; background:var(--hl) }` and `.fb i { background:var(--fk-model) }` */
export const fillBar = "block h-[7px] min-w-0 overflow-hidden rounded bg-hl";
export const fillBarFill = "block h-full rounded bg-fk-model";

/** `.stk i.neu`, `.leg i.neu { background:var(--rule) }`: the part that is not the figure. */
const NEUTRAL = "bg-rule";

/** How many families the tile names before it folds the rest into "other". */
const FAMILY_ROWS = 4;

/** The narrowest a priced column is drawn, as a share of the dearest one. */
const MIN_COLUMN = 0.04;

/** `.inst .iv small .delta.down { font-size:11px; font-weight:600; color:var(--st-denied) }`: calls that failed. */
const failedUnit =
  "ml-1.5 text-[11px] font-semibold tracking-normal text-warning tabular-nums";

type Part = {
  key: string;
  label: string;
  value: number;
  hue: string;
  shown: ReactNode;
};

/**
 * The pieces of a line, with the mockup's mid-dot between each. Each piece is
 * keyed by its name, and a null piece is left out along with its dot.
 */
function Dotted({ parts }: { parts: Readonly<Record<string, ReactNode>> }) {
  const shown = Object.entries(parts).filter(([, part]) => part !== null);
  return (
    <>
      {shown.map(([key, part], index) => (
        <Fragment key={key}>
          {index === 0 ? null : " · "}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function Tile({
  title,
  basis,
  value,
  line,
  chart,
  foot,
  testId,
}: {
  title: string;
  basis: ReactNode;
  value: ReactNode;
  line?: ReactNode;
  chart?: ReactNode;
  foot?: ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className={inst}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className={instKey}>{title}</h4>
        <span className={instBasis}>{basis}</span>
      </div>
      <div data-testid={`${testId}-value`} className={instValue}>
        {value}
      </div>
      {line === undefined ? null : <div className={instLine}>{line}</div>}
      {chart}
      {foot === undefined ? null : <div className={instLine}>{foot}</div>}
    </div>
  );
}

/** `.stk` and its `.leg`: parts of one whole by width, each named with its figure. */
function Stacked({ parts, label }: { parts: readonly Part[]; label: string }) {
  const drawn = parts.filter((part) => part.value > 0);
  return (
    <>
      <div role="img" aria-label={label} className={stack}>
        {drawn.map((part) => (
          <i
            key={part.key}
            title={part.label}
            className={`${stackPart} ${part.hue}`}
            style={{ flex: part.value }}
          />
        ))}
      </div>
      <div className={legend}>
        {drawn.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-[5px]">
            <i aria-hidden="true" className={`${legendSwatch} ${part.hue}`} />
            {part.label}
            <b className="font-semibold text-foreground">{part.shown}</b>
          </span>
        ))}
      </div>
    </>
  );
}

/** `.ax`: the first and last turn under a column chart. */
function TurnAxis({ turns, live }: { turns: number; live: boolean }) {
  const t = useTranslations("run.cost.inst");
  return (
    <div className={axis}>
      <span>{t("turnAxis", { turn: 1 })}</span>
      <span>
        {live
          ? t("turnAxisLive", { turn: turns })
          : t("turnAxis", { turn: turns })}
      </span>
    </div>
  );
}

/** How many models the provisional line names before it counts the rest. */
const PROVISIONAL_MODELS = 3;

/**
 * The per-model line of a wrapped run the rollup has not reached (#4032):
 * each model with what the session reported it cost and over how many calls,
 * dearest first, so a live run's spend is readable before it is rolled up.
 */
function ProvisionalModels({
  provisional,
}: {
  provisional: ProvisionalSpend;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const shown = provisional.byModel.slice(0, PROVISIONAL_MODELS);
  const more = provisional.byModel.length - shown.length;
  const part = ({ model, cost, calls }: ProvisionalModel) =>
    cost === null
      ? t.rich("provisionalModelUnpriced", {
          model: () => <b>{model}</b>,
          calls,
        })
      : t.rich("provisionalModel", {
          model: () => <b>{model}</b>,
          cost: () => (
            <b>{formatMoney(cost, { locale, precision: "cents" })}</b>
          ),
          calls,
        });
  return (
    <span data-testid="inst-cost-provisional">
      {shown.map((row, index) => (
        <Fragment key={`${row.provider ?? ""}/${row.model}`}>
          {index === 0 ? null : ", "}
          {part(row)}
        </Fragment>
      ))}
      {more > 0 ? <>, {t("provisionalMore", { count: more })}</> : null}
    </span>
  );
}

function CostTile({
  run,
  metrics,
  ledger,
  live,
}: {
  run: RunRow;
  metrics: RunMetrics;
  /** Null when the per-turn read failed. */
  ledger: Ledger | null;
  live: boolean;
}) {
  const t = useTranslations("run.cost.inst");
  const tCost = useTranslations("run.cost");
  const locale = useLocale();
  const { cacheHit } = metrics;
  // Nothing metered the run yet: the figure the stat row prints stands in,
  // labelled provisional, with the models the session reported under it.
  const reported = provisionalCost(run, metrics);
  const cost = metrics.cost ?? reported?.value ?? null;
  const provisional = metrics.cost === null ? metrics.provisional : null;
  const saved = metrics.priced?.cacheSaved ?? null;
  // A run that read nothing from the cache saved nothing, so it has no saving
  // to report; one that did and has none recorded says so.
  const readCache = (metrics.tokens?.byClass.cache_read ?? 0) > 0;
  // The mean of the bars below it, so "per turn" is read off the same ledger.
  const each =
    ledger === null ? null : perTurn(ledger.cost, ledger.rows.length);
  const max = ledger?.max ?? null;
  const money = (value: Money) =>
    formatMoney(value, { locale, precision: "cents" });
  return (
    <Tile
      testId="inst-cost"
      title={t("cost")}
      basis={
        metrics.cost !== null
          ? (metrics.cost.basis ?? tCost("basisNotRecorded"))
          : reported === null
            ? null
            : t("provisional")
      }
      value={
        cost === null ? (
          <NoValue />
        ) : (
          <>
            <MoneyText value={cost} />
            {reported?.floor === true ? "+" : null}
            <small className={instUnit}>{cost.currency}</small>
          </>
        )
      }
      line={
        <Dotted
          parts={{
            models:
              provisional === null ||
              provisional.byModel.length === 0 ? null : (
                <ProvisionalModels provisional={provisional} />
              ),
            perTurn:
              each === null
                ? null
                : t.rich("perTurn", { cost: () => <b>{money(each)}</b> }),
            dearest:
              ledger === null || ledger.dearest === null
                ? null
                : t("dearest", { turn: ledger.dearest }),
            median: t("median"),
          }}
        />
      }
      chart={
        ledger === null || ledger.rows.length === 0 ? undefined : (
          <div>
            <div role="img" aria-label={t("costChart")} className={cols}>
              {ledger.rows.map((row, index) => {
                const share =
                  row.cost === null ||
                  max === null ||
                  row.cost.currency !== max.currency
                    ? null
                    : ratioOfIntegers(row.cost.micros, max.micros);
                const last = index === ledger.rows.length - 1;
                const { turn } = row;
                return (
                  <span
                    key={row.seq}
                    data-testid="inst-cost-col"
                    title={
                      row.cost === null
                        ? t("turnUnpriced", { turn })
                        : t("turnCost", { turn, cost: money(row.cost) })
                    }
                    className={`${col} ${last && live ? colCurrent : ""}`}
                  >
                    {index + 1 === ledger.dearest && row.cost !== null ? (
                      <span className={colLabel}>{money(row.cost)}</span>
                    ) : null}
                    {share === null ? null : (
                      <i
                        className={`${colFill} bg-fk-model`}
                        style={{
                          height: ratioWidth(Math.max(share, MIN_COLUMN)),
                        }}
                      />
                    )}
                  </span>
                );
              })}
              <span aria-hidden="true" className={colBase} />
            </div>
            <TurnAxis turns={ledger.rows.length} live={live} />
          </div>
        )
      }
      foot={
        cacheHit === null
          ? t("cacheNotRecorded")
          : saved === null
            ? t.rich(readCache ? "savingNotRecorded" : "cacheHitOnly", {
                hit: () => <b>{formatRatio(cacheHit, locale)}</b>,
              })
            : t.rich("cacheSaved", {
                hit: () => <b>{formatRatio(cacheHit, locale)}</b>,
                saved: () => <b>{money(saved)}</b>,
              })
      }
    />
  );
}

/** The wall clock's parts, in the mockup's order, with the hue each takes. */
const WALL_PARTS: readonly { key: WallLead; hue: string }[] = [
  { key: "model", hue: "bg-fk-model" },
  { key: "tool", hue: "bg-fk-tool" },
  { key: "waiting", hue: "bg-fk-gov" },
  { key: "harness", hue: NEUTRAL },
];

function WallTile({ metrics }: { metrics: RunMetrics }) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const { wall, batches } = metrics;
  const { parts, lead, ms } = wall;
  return (
    <Tile
      testId="inst-wall"
      title={t("wall")}
      basis={wall.sealed ? t("startToSeal") : t("soFar")}
      value={
        ms === null ? (
          <NoValue />
        ) : (
          <>
            {wall.ticking === null ? (
              formatDuration(ms, locale)
            ) : (
              // A live run's clock keeps counting from its start, as the stat
              // row's does; the split below is as of the render.
              <Clock
                at={wall.ticking.from}
                now={wall.ticking.at}
                direction="since"
                className="tabular-nums"
              />
            )}
            <small className={instUnit}>{t("elapsed")}</small>
          </>
        )
      }
      line={
        parts === null || lead === null || ms === null || ms === 0
          ? t("wallNoSplit")
          : t.rich("wallLead", {
              share: () => <b>{formatRatio(parts[lead] / ms, locale)}</b>,
              part: t(`wallLeadPart.${lead}`),
            })
      }
      chart={
        parts === null ? undefined : (
          <Stacked
            label={t("wallChart")}
            parts={WALL_PARTS.map(({ key, hue }) => ({
              key,
              hue,
              label: t(`wallPart.${key}`),
              value: parts[key],
              shown: formatDuration(parts[key], locale),
            }))}
          />
        )
      }
      foot={
        batches === null
          ? undefined
          : t.rich("batchesFoot", {
              count: batches.count,
              together: () => (
                <b>{formatDuration(batches.togetherMs, locale)}</b>
              ),
              serial: () => <b>{formatDuration(batches.serialMs, locale)}</b>,
            })
      }
    />
  );
}

function TokensTile({
  metrics,
  prices,
}: {
  metrics: RunMetrics;
  prices: ClassPrices;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const { tokens, cacheHit, perModelCall } = metrics;
  const count = (value: number) => formatCount(value, locale);
  if (tokens === null) {
    return (
      <Tile
        testId="inst-tokens"
        title={t("tokens")}
        basis={t("inAndOut")}
        value={<NoValue />}
        line={t("tokensNotRolledUp")}
      />
    );
  }
  const { byClass } = tokens;
  const writes = byClass.cache_write_5m + byClass.cache_write_1h;
  const rate = prices.inputRate;
  return (
    <Tile
      testId="inst-tokens"
      title={t("tokens")}
      basis={t("inAndOut")}
      value={
        <>
          {count(tokens.total)}
          <small className={instUnit}>{t("tokensUnit")}</small>
        </>
      }
      line={
        <Dotted
          parts={{
            inOut: t.rich("inOut", {
              input: () => <b>{count(tokens.input)}</b>,
              output: () => <b>{count(tokens.output)}</b>,
            }),
            reasoning:
              byClass.reasoning === 0
                ? null
                : t("reasoning", { reasoning: count(byClass.reasoning) }),
          }}
        />
      }
      chart={
        <Stacked
          label={t("tokensChart")}
          parts={[
            {
              key: "cacheRead",
              hue: "bg-fk-model",
              label: t("tokenPart.cacheRead"),
              value: byClass.cache_read,
              shown: count(byClass.cache_read),
            },
            {
              key: "fresh",
              hue: "bg-fk-tool",
              label: t("tokenPart.fresh"),
              value: byClass.input_uncached,
              shown: count(byClass.input_uncached),
            },
            {
              key: "cacheWrite",
              hue: "bg-fk-ctx",
              label: t("tokenPart.cacheWrite"),
              value: writes,
              shown: count(writes),
            },
            {
              key: "output",
              hue: "bg-fk-gov",
              label: t("tokenPart.output"),
              value: tokens.output,
              shown: count(tokens.output),
            },
          ]}
        />
      }
      foot={
        <Dotted
          parts={{
            hit:
              cacheHit === null
                ? t("cacheNotRecorded")
                : t.rich("cacheOfInput", {
                    hit: () => <b>{formatRatio(cacheHit, locale)}</b>,
                  }),
            perCall:
              perModelCall === null
                ? null
                : t.rich("perCall", {
                    count: () => <b>{count(perModelCall)}</b>,
                  }),
            rate:
              rate === null
                ? t("rateNotPriced")
                : t.rich("rate", {
                    rate: () => (
                      <b>{formatMoney(rate, { locale, precision: "cents" })}</b>
                    ),
                  }),
            writes: writes === 0 ? t("nothingWritten") : null,
          }}
        />
      }
    />
  );
}

function ShapeTile({
  run,
  metrics,
  ledger,
  live,
}: {
  run: RunRow;
  metrics: RunMetrics;
  /** Null when the per-turn read failed. */
  ledger: Ledger | null;
  live: boolean;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const rows = ledger?.rows ?? [];
  const widest = Math.max(0, ...rows.map((row) => row.steps));
  // `.lab` names the busiest turn once, over the first column that reaches it.
  const labelled = rows.findIndex((row) => row.steps === widest);
  const calls = metrics.toolCalls?.length ?? null;
  const { batches } = metrics;
  return (
    <Tile
      testId="inst-shape"
      title={t("shape")}
      basis={t("framesInRun", { count: run.frames })}
      value={
        ledger === null ? (
          <NoValue />
        ) : (
          <>
            {count(ledger.rows.length)}
            <small className={instUnit}>{t("turnsUnit")}</small>
            <span className={instSep}>·</span>
            {count(ledger.steps)}
            <small className={instUnit}>{t("stepsUnit")}</small>
            <span className={instSep}>·</span>
            {count(ledger.frames)}
            <small className={instUnit}>{t("framesUnit")}</small>
          </>
        )
      }
      line={t("shapeLine")}
      chart={
        ledger === null || ledger.rows.length === 0 ? undefined : (
          <div>
            <div role="img" aria-label={t("stepsChart")} className={cols}>
              {ledger.rows.map((row, index) => {
                const { turn } = row;
                return (
                  <span
                    key={row.seq}
                    title={t("turnSteps", {
                      turn,
                      steps: row.steps,
                      model: row.modelSteps,
                      tool: row.toolSteps,
                    })}
                    className={col}
                  >
                    {index === labelled && widest > 0 ? (
                      <span className={colLabel}>{count(row.steps)}</span>
                    ) : null}
                    {row.toolSteps === 0 ? null : (
                      <i
                        className={`${colFill} bg-fk-tool`}
                        style={{ height: ratioWidth(row.toolSteps / widest) }}
                      />
                    )}
                    {row.modelSteps === 0 ? null : (
                      <i
                        className={`${colFill} bg-fk-model`}
                        style={{ height: ratioWidth(row.modelSteps / widest) }}
                      />
                    )}
                  </span>
                );
              })}
              <span aria-hidden="true" className={colBase} />
            </div>
            <TurnAxis turns={ledger.rows.length} live={live} />
            <div className={`${legend} mt-2`}>
              <span className="inline-flex items-center gap-[5px]">
                <i
                  aria-hidden="true"
                  className={`${legendSwatch} bg-fk-model`}
                />
                {t("modelCalls")}
                <b className="font-semibold text-foreground">
                  {count(ledger.modelSteps)}
                </b>
              </span>
              <span className="inline-flex items-center gap-[5px]">
                <i
                  aria-hidden="true"
                  className={`${legendSwatch} bg-fk-tool`}
                />
                {t("toolCalls")}
                <b className="font-semibold text-foreground">
                  {count(ledger.toolSteps)}
                </b>
              </span>
            </div>
          </div>
        )
      }
      foot={
        batches === null || calls === null
          ? undefined
          : t.rich("fanOut", {
              calls: () => <b>{count(calls)}</b>,
              batches: () => <b>{count(batches.count)}</b>,
            })
      }
    />
  );
}

function FamilyRows({ families: rows }: { families: readonly Family[] }) {
  const t = useTranslations("run.cost");
  const locale = useLocale();
  const top = rows.slice(0, FAMILY_ROWS);
  const rest = rows.slice(FAMILY_ROWS).reduce((sum, row) => sum + row.calls, 0);
  const widest = rows[0]?.calls ?? 1;
  return (
    <div className={families}>
      {top.map((family) => (
        <div
          key={family.group}
          data-testid="inst-family"
          title={t("inst.familyTitle", {
            family: t(`families.${family.group}`),
            calls: family.calls,
            tools: family.tools,
          })}
          className={familyRow}
        >
          <span className={familyIcon}>
            <ToolIcon group={family.group} />
          </span>
          <span className={familyLabel}>{t(`families.${family.group}`)}</span>
          <span className={fillBar}>
            <i
              className={fillBarFill}
              style={{ width: ratioWidth(family.calls / widest) }}
            />
          </span>
          <span className={familyCount}>
            {formatCount(family.calls, locale)}
          </span>
        </div>
      ))}
      {rest === 0 ? null : (
        <div className={`${familyRow} text-dim`}>
          <span />
          <span className={familyLabel}>{t("inst.other")}</span>
          <span className={fillBar}>
            <i
              className={fillBarFill}
              style={{ width: ratioWidth(rest / widest) }}
            />
          </span>
          <span className={familyCount}>{formatCount(rest, locale)}</span>
        </div>
      )}
    </div>
  );
}

function CallsTile({ metrics }: { metrics: RunMetrics }) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const { toolCalls, families: fams, batches } = metrics;
  if (toolCalls === null || fams === null) {
    return (
      <Tile
        testId="inst-calls"
        title={t("calls")}
        basis={null}
        value={<NoValue />}
      />
    );
  }
  const failed = toolCalls.filter((call) => call.failed).length;
  return (
    <Tile
      testId="inst-calls"
      title={t("calls")}
      basis={t("familyCount", { count: fams.length })}
      value={
        <>
          {count(toolCalls.length)}
          <small className={instUnit}>{t("callsUnit")}</small>
          {failed === 0 ? null : (
            <small className={failedUnit}>
              {t("failed", { count: failed })}
            </small>
          )}
        </>
      }
      chart={fams.length === 0 ? undefined : <FamilyRows families={fams} />}
      foot={
        batches === null
          ? t("noCalls")
          : t.rich("parallel", {
              parallel: () => <b>{count(batches.parallel)}</b>,
              count: batches.count,
              widest: () => <b>{count(batches.widest)}</b>,
            })
      }
    />
  );
}

function RatioTile({
  metrics,
  retries,
}: {
  metrics: RunMetrics;
  retries: number | null;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const ratio = metrics.productiveRatio;
  return (
    <Tile
      testId="inst-ratio"
      title={t("ratio")}
      basis={t("advancedTask")}
      value={ratio === null ? <NoValue /> : formatRatio(ratio, locale)}
      line={t("thirtyDay")}
      chart={
        ratio === null ? undefined : (
          <Stacked
            label={t("ratioChart")}
            parts={[
              {
                key: "advanced",
                hue: "bg-fk-model",
                label: t("advanced"),
                value: ratio,
                shown: formatRatio(ratio, locale),
              },
              {
                key: "didNot",
                hue: NEUTRAL,
                label: t("didNot"),
                value: 1 - ratio,
                shown: formatRatio(1 - ratio, locale),
              },
            ]}
          />
        )
      }
      foot={
        retries === null
          ? undefined
          : t.rich("retries", {
              count: retries,
              n: () => <b>{formatCount(retries, locale)}</b>,
            })
      }
    />
  );
}

export function Instruments({
  run,
  metrics,
  ledger,
  prices,
  retries,
}: {
  run: RunRow;
  metrics: RunMetrics;
  /** The per-turn ledger from `get_run_turns`; null when that read failed. */
  ledger: Ledger | null;
  prices: ClassPrices;
  /** The rollup's retries; null when the rollup has not run or did not count them. */
  retries: number | null;
}) {
  const t = useTranslations("run.cost.inst");
  const live = run.sealedAt === null;
  return (
    <section
      aria-label={t("label")}
      data-testid="run-instruments"
      className={instGrid}
    >
      <CostTile run={run} metrics={metrics} ledger={ledger} live={live} />
      <WallTile metrics={metrics} />
      <TokensTile metrics={metrics} prices={prices} />
      <ShapeTile run={run} metrics={metrics} ledger={ledger} live={live} />
      <CallsTile metrics={metrics} />
      <RatioTile metrics={metrics} retries={retries} />
    </section>
  );
}
