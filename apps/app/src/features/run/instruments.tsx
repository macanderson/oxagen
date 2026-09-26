// The six instruments across the top of the Cost tab (pages/run.md, Cost; the
// mockup's `runInstruments`): Cost so far, Wall clock, Tokens, Shape of the
// run, Tool calls and Productive ratio. Each tile is one figure, one line
// under it, a small chart and a foot.
//
// Every figure is read from `runMetrics` and from the per-turn ledger
// `cost-figures.ts` sums from `get_run_turns`, so the Tokens tile is the stat
// row's Tokens figure and the total row of Spend by token class, and the Shape
// tile's steps and frames are the waterfall's total row.
//
// Cost so far and Productive ratio set the run beside the agent's own sealed
// runs in the 30 days before it started (`get_run_cost`'s baseline, #3984,
// ADR-192): the gap to the agent's median run, and the points between this
// run's ratio and the 30-day one. A baseline the agent's history is too thin
// for reads not recorded, never a guessed figure. Productive ratio's foot
// names why the steps that did not advance the task made no progress, from
// the causes the rollup recorded.
import { useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import {
  differenceOfMicros,
  type Money,
  ratioOfIntegers,
} from "@/data/contracts/money";
import type { RunCost } from "@/data/contracts/run";
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
import {
  cacheRebuildShare,
  type ClassPrices,
  type Ledger,
  perTurn,
} from "./cost-figures";
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

/** The agent's 30 days before the run, as `get_run_cost` answers them; null when too thin. */
type Baseline = NonNullable<RunCost["baseline"]>;

/** The rollup's graded steps: null together until the rollup grades the run. */
type GradedSteps = {
  advanced: number | null;
  unproductive: number | null;
  causes: { failed: number; repeated: number; retried: number } | null;
};

/** The causes Productive ratio's foot names, in the order it names them. */
const CAUSES = ["failed", "repeated", "retried"] as const;

/** A signed whole number of points between two ratios: `+9`, `−3`, `0`. */
function pointsBetween(ratio: number, base: number): number {
  return Math.round((ratio - base) * 100);
}

/** The sign a delta prints with; a zero delta prints none. */
function signOf(n: -1 | 0 | 1): string {
  return n > 0 ? "+" : n < 0 ? "−" : "";
}

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
function ProvisionalModels({ provisional }: { provisional: ProvisionalSpend }) {
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

/**
 * The run set against the agent's median run: the gap and the median, the
 * median alone when the run has no cost to set against it, or not recorded
 * when the agent's history is too thin to have one.
 */
function MedianLine({
  cost,
  baseline,
}: {
  cost: Money | null;
  baseline: Baseline | null;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const median = baseline?.medianCost ?? null;
  if (median === null) return <>{t("median")}</>;
  const money = (value: Money) =>
    formatMoney(value, { locale, precision: "cents" });
  const gap = cost === null ? null : differenceOfMicros(cost, median);
  return (
    <span data-testid="inst-cost-median">
      {gap === null
        ? t.rich("medianOnly", { median: () => <b>{money(median)}</b> })
        : t.rich("medianDelta", {
            delta: () => (
              <b>
                {signOf(gap.sign)}
                {money(gap.gap)}
              </b>
            ),
            median: () => <b>{money(median)}</b>,
          })}
    </span>
  );
}

function CostTile({
  run,
  metrics,
  ledger,
  live,
  baseline,
}: {
  run: RunRow;
  metrics: RunMetrics;
  /** Null when the per-turn read failed. */
  ledger: Ledger | null;
  live: boolean;
  baseline: Baseline | null;
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
            // The recorded cost, not the session's provisional figure: the
            // median is of rolled-up runs, so only a rolled-up figure is set
            // against it.
            median: <MedianLine cost={metrics.cost} baseline={baseline} />,
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

/**
 * A share above zero never prints as 0%. `formatRatio` keeps one decimal, so
 * a share under 0.05% would round to "0%" while the run did write.
 */
function formatShare(share: number, locale: string): string {
  return share > 0 && share < 0.0005
    ? `<${formatRatio(0.001, locale)}`
    : formatRatio(share, locale);
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
  const rebuilt = cacheRebuildShare(tokens);
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
            // The hit rate leaves cache writes out, so a rebuilt cache shows
            // here as the share of input written to it (A-08).
            writes:
              writes === 0 || rebuilt === null
                ? t("nothingWritten")
                : t.rich("written", {
                    share: () => <b>{formatShare(rebuilt, locale)}</b>,
                  }),
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
  const calls = metrics.toolCalls?.count ?? null;
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
  const { failed } = toolCalls;
  return (
    <Tile
      testId="inst-calls"
      title={t("calls")}
      basis={t("familyCount", { count: fams.length })}
      value={
        <>
          {count(toolCalls.count)}
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

/**
 * This run's ratio set against the agent's 30-day one: the points between
 * them, the 30-day ratio alone when this run is not graded, or not recorded
 * when the agent's history is too thin to have one.
 */
function ThirtyDayLine({
  ratio,
  baseline,
}: {
  ratio: number | null;
  baseline: Baseline | null;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const base = baseline?.productiveRatio ?? null;
  if (base === null) return <>{t("thirtyDay")}</>;
  if (ratio === null)
    return (
      <span data-testid="inst-ratio-baseline">
        {t.rich("thirtyDayOnly", {
          ratio: () => <b>{formatRatio(base, locale)}</b>,
        })}
      </span>
    );
  const points = pointsBetween(ratio, base);
  return (
    <span data-testid="inst-ratio-baseline">
      {t.rich("thirtyDayDelta", {
        delta: () => (
          <b>
            {t("points", {
              sign: signOf(points > 0 ? 1 : points < 0 ? -1 : 0),
              count: Math.abs(points),
            })}
          </b>
        ),
        ratio: () => <b>{formatRatio(base, locale)}</b>,
      })}
    </span>
  );
}

/**
 * Why the steps that did not advance the task made no progress, from the
 * causes the rollup recorded; the retry count alone on a run it has not
 * graded.
 */
function RatioFoot({
  steps,
  retries,
}: {
  steps: GradedSteps | null;
  retries: number | null;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const causes = steps?.causes ?? null;
  const unproductive = steps?.unproductive ?? null;
  if (causes !== null && unproductive !== null) {
    if (unproductive === 0)
      return <span data-testid="inst-ratio-causes">{t("allAdvanced")}</span>;
    const named = CAUSES.filter((cause) => causes[cause] > 0).map((cause) =>
      t(`causes.${cause}`, { count: formatCount(causes[cause], locale) }),
    );
    return (
      <span data-testid="inst-ratio-causes">
        {t.rich("unproductive", {
          count: unproductive,
          n: () => <b>{formatCount(unproductive, locale)}</b>,
          causes: named.join(", "),
        })}
      </span>
    );
  }
  if (retries === null) return null;
  return (
    <>
      {t.rich("retries", {
        count: retries,
        n: () => <b>{formatCount(retries, locale)}</b>,
      })}
    </>
  );
}

function RatioTile({
  metrics,
  retries,
  steps,
  baseline,
}: {
  metrics: RunMetrics;
  retries: number | null;
  steps: GradedSteps | null;
  baseline: Baseline | null;
}) {
  const t = useTranslations("run.cost.inst");
  const locale = useLocale();
  const ratio = metrics.productiveRatio;
  const advanced = steps?.advanced ?? null;
  const unproductive = steps?.unproductive ?? null;
  // The counts when the rollup graded the run, so the legend reads "18
  // advanced, 6 did not"; the shares alone on a row graded before the counts
  // were stored.
  const counted = advanced !== null && unproductive !== null;
  const graded = counted && steps?.causes !== null;
  return (
    <Tile
      testId="inst-ratio"
      title={t("ratio")}
      basis={t("advancedTask")}
      value={ratio === null ? <NoValue /> : formatRatio(ratio, locale)}
      line={<ThirtyDayLine ratio={ratio} baseline={baseline} />}
      chart={
        ratio === null ? undefined : (
          <Stacked
            label={t("ratioChart")}
            parts={[
              {
                key: "advanced",
                hue: "bg-fk-model",
                label: t("advanced"),
                value: counted ? advanced : ratio,
                shown: counted
                  ? t("stepCount", { count: advanced })
                  : formatRatio(ratio, locale),
              },
              {
                key: "didNot",
                hue: NEUTRAL,
                label: t("didNot"),
                value: counted ? unproductive : 1 - ratio,
                shown: counted
                  ? t("stepCount", { count: unproductive })
                  : formatRatio(1 - ratio, locale),
              },
            ]}
          />
        )
      }
      foot={
        graded || retries !== null ? (
          <RatioFoot steps={steps} retries={retries} />
        ) : undefined
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
  steps,
  baseline,
}: {
  run: RunRow;
  metrics: RunMetrics;
  /** The per-turn ledger from `get_run_turns`; null when that read failed. */
  ledger: Ledger | null;
  prices: ClassPrices;
  /** The rollup's retries; null when the rollup has not run or did not count them. */
  retries: number | null;
  /** The rollup's graded steps; null when the rollup has not run. */
  steps: GradedSteps | null;
  /** The agent's 30 days before the run; null when its history is too thin. */
  baseline: Baseline | null;
}) {
  const t = useTranslations("run.cost.inst");
  // Live is the run's status, as everywhere else on the page. A halted run
  // can have no seal, and reading liveness from the seal would mark its last
  // turn as still running (#3375).
  const live = run.status === "live";
  return (
    <section
      aria-label={t("label")}
      data-testid="run-instruments"
      className={instGrid}
    >
      <CostTile
        run={run}
        metrics={metrics}
        ledger={ledger}
        live={live}
        baseline={baseline}
      />
      <WallTile metrics={metrics} />
      <TokensTile metrics={metrics} prices={prices} />
      <ShapeTile run={run} metrics={metrics} ledger={ledger} live={live} />
      <CallsTile metrics={metrics} />
      <RatioTile
        metrics={metrics}
        retries={retries}
        steps={steps}
        baseline={baseline}
      />
    </section>
  );
}
