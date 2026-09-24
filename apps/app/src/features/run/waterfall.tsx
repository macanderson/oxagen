// The run waterfall (spec §12.9; pages/run.md, Cost; the mockup's `costTab`
// and `wfChart`): one bar per turn at its own cost on the left scale, the
// cost accumulating across them as a dashed line, and the per-turn table
// under it with a total row.
//
// It reads the per-turn ledger `get_run_turns` counts over every frame of the
// run (#4067), summed by `ledgerOf`, so a turn's cost here is the sum of the
// costs the Transcript tab prints against that turn's entries, and the total
// row's steps and frames are the Shape of the run instrument's. The total row
// is the sum of the rows, set against the run's recorded cost ("of $ recorded")
// rather than typed as it: the two differ when a cost record sits outside
// every turn.
//
// A turn whose cost the recording did not carry draws no bar and says so in
// its Cost cell: a zero-height bar would read as "this turn cost nothing", a
// measurement nobody made. Finding pins are not recorded (no contract names
// the turn a Spend finding points at), so the Pinned column says that in
// every row rather than drawing a pin.
import { useLocale, useTranslations } from "next-intl";
import {
  type Money,
  ratioOfIntegers,
  shareOfMicros,
} from "@/data/contracts/money";
import type { RunTurns } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { Money as MoneyText } from "@/ui/money";
import { formatCount, formatMoney, formatRatio } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import type { Ledger } from "./cost-figures";
import type { RunMetrics } from "./metrics";
import { NoValue, Panel, PanelBody } from "./parts";

/** `wfChart`'s frame: `W=760, H=264, pl=56, pr=64, pt=36, pb=44`. */
const W = 760;
const H = 264;
const PAD = { left: 56, right: 64, top: 36, bottom: 44 } as const;
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;
/** `bw = min(64, gap * 0.62)`: a bar's width in its slot. */
const BAR_MAX = 64;
const BAR_SHARE = 0.62;
/** Gridlines at a quarter of the dearest turn each: `for(i=0;i<=4;i++)`. */
const GRID_STEPS = 4;

/** `.wf-svg { width:100%; min-width:520px; height:auto; display:block }` */
const chartSvg = "block h-auto w-full min-w-[520px]";
/** `rect.wf-bar { fill:var(--st-approval); opacity:.8 }`; a turn carrying a finding would take `--st-denied`. */
const barFill = "fill-info opacity-80";
/** The chart's legend: `.row { gap:14px; margin-top:10px; font-size:11.5px; color:var(--muted) }`. */
const chartLegend =
  "mt-2.5 flex flex-wrap items-center gap-3.5 text-[11.5px] text-muted-foreground";
/** The turn-cost swatch, `width:9px; height:9px; border-radius:2px; background:var(--st-approval)`. */
const swatch = "inline-block size-[9px] rounded-[2px] bg-info";
/** The cost-so-far key, `width:14px; border-top:2px dashed var(--fg)`. */
const dashKey = "inline-block w-3.5 border-t-2 border-dashed border-foreground";
/** `p.muted { font-size:11.5px; margin:10px 0 0 }`: how to read the chart. */
const caption = "mb-0 mt-2.5 text-[11.5px] text-muted-foreground";

/** One decimal place, for a coordinate: the chart's own `toFixed(1)`. */
function at(value: number): number {
  return Math.round(value * 10) / 10;
}

function Chart({ ledger, total }: { ledger: Ledger; total: Money }) {
  const t = useTranslations("run.waterfall");
  const locale = useLocale();
  const money = (value: Money) =>
    formatMoney(value, { locale, precision: "cents" });
  const max = ledger.max;
  const n = ledger.rows.length;
  const gap = INNER_W / n;
  const bar = Math.min(BAR_MAX, gap * BAR_SHARE);
  const x = (index: number) => PAD.left + gap * index + gap / 2;
  const base = PAD.top + INNER_H;
  /** Height on the left scale: a share of the dearest turn. */
  const barY = (value: Money | null) =>
    value === null || max === null || value.currency !== max.currency
      ? null
      : base - ratioOfIntegers(value.micros, max.micros) * INNER_H;
  /** Height on the running scale: a share of every turn's cost together. */
  const runY = (value: Money | null) =>
    value === null || value.currency !== total.currency
      ? base
      : base - ratioOfIntegers(value.micros, total.micros) * INNER_H;
  const points = [
    `${String(PAD.left)},${String(at(base))}`,
    ...ledger.rows.map(
      (row, index) =>
        `${String(at(x(index) + bar / 2))},${String(at(runY(row.to)))}`,
    ),
  ];
  const end = runY(total);
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      aria-label={t("chart", { total: money(total) })}
      data-testid="waterfall"
      className={chartSvg}
    >
      {max === null
        ? null
        : Array.from({ length: GRID_STEPS + 1 }, (_, step) => {
            const value = shareOfMicros(max, step / GRID_STEPS);
            const y = at(base - (step / GRID_STEPS) * INNER_H);
            return (
              <g key={step}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={W - PAD.right}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={at(y + 3.5)}
                  textAnchor="end"
                  fontSize={10.5}
                  className="fill-dim"
                >
                  {value === null ? null : money(value)}
                </text>
              </g>
            );
          })}
      <line
        x1={PAD.left}
        y1={base}
        x2={W - PAD.right}
        y2={base}
        className="stroke-rule"
      />
      {ledger.rows.map((row, index) => {
        const top = barY(row.cost);
        const { turn } = row;
        return (
          <g key={row.seq}>
            {top === null || row.cost === null ? null : (
              <>
                <rect
                  data-testid="waterfall-bar"
                  data-turn={turn}
                  x={at(x(index) - bar / 2)}
                  y={at(Math.min(top, base - 2))}
                  width={at(bar)}
                  height={at(Math.max(2, base - top))}
                  rx={3}
                  className={barFill}
                >
                  <title>
                    {t("barTitle", {
                      turn,
                      cost: money(row.cost),
                      steps: row.steps,
                      frames: row.frames,
                    })}
                  </title>
                </rect>
                <text
                  x={at(x(index))}
                  y={at(Math.min(top, base - 2) - 6)}
                  textAnchor="middle"
                  fontSize={10.5}
                  className="fill-foreground"
                >
                  {money(row.cost)}
                </text>
              </>
            )}
            <text
              x={at(x(index))}
              y={base + 16}
              textAnchor="middle"
              fontSize={11}
              className="fill-muted-foreground"
            >
              {t("turnLabel", { turn })}
            </text>
            <text
              x={at(x(index))}
              y={base + 30}
              textAnchor="middle"
              fontSize={10}
              className="fill-dim"
            >
              {row.cacheHit === null
                ? t("cacheNotRecorded")
                : t("cache", { hit: formatRatio(row.cacheHit, locale) })}
            </text>
          </g>
        );
      })}
      <path
        d={`M${points.join("L")}`}
        fill="none"
        strokeWidth={1.6}
        strokeDasharray="4 3"
        strokeLinejoin="round"
        className="stroke-foreground opacity-75"
      />
      {points.slice(1).map((point) => {
        const [cx, cy] = point.split(",");
        return (
          <circle
            key={point}
            cx={cx}
            cy={cy}
            r={2.6}
            className="fill-foreground"
          />
        );
      })}
      <text
        x={W - PAD.right + 8}
        y={at(end + 3.5)}
        fontSize={11}
        fontWeight={600}
        className="fill-foreground"
      >
        {money(total)}
      </text>
      <text
        x={W - PAD.right + 8}
        y={at(end + 16)}
        fontSize={10}
        className="fill-dim"
      >
        {t("total")}
      </text>
    </svg>
  );
}

function LedgerTable({
  metrics,
  ledger,
}: {
  metrics: RunMetrics;
  ledger: Ledger;
}) {
  const t = useTranslations("run.waterfall");
  const locale = useLocale();
  const money = (value: Money) =>
    formatMoney(value, { locale, precision: "cents" });
  const count = (value: number) => formatCount(value, locale);
  return (
    <Table
      label={t("tableLabel")}
      columns={[
        { label: t("columns.turn") },
        { label: t("columns.steps"), numeric: true },
        { label: t("columns.frames"), numeric: true },
        { label: t("columns.cache"), numeric: true },
        { label: t("columns.cost"), numeric: true },
        { label: t("columns.running"), numeric: true },
        { label: t("columns.pinned") },
      ]}
    >
      {ledger.rows.map((row) => (
        <tr key={row.seq} data-testid="waterfall-row" data-seq={row.seq}>
          <td className={`${cell} ${mono}`}>
            {t("turnLabel", { turn: row.turn })}
          </td>
          <td className={numericCell}>{count(row.steps)}</td>
          <td className={numericCell}>{count(row.frames)}</td>
          <td className={numericCell}>
            {row.cacheHit === null ? (
              <NoValue />
            ) : (
              formatRatio(row.cacheHit, locale)
            )}
          </td>
          <td className={numericCell}>
            {row.cost === null ? <NoValue /> : <MoneyText value={row.cost} />}
          </td>
          <td className={`${numericCell} text-dim`}>
            {row.from === null || row.to === null ? (
              <NoValue />
            ) : (
              t("running", { from: money(row.from), to: money(row.to) })
            )}
          </td>
          <td className={cell}>
            <NoValue />
          </td>
        </tr>
      ))}
      <tr data-testid="waterfall-total" className="font-semibold">
        <td className={cell}>{t("totalRow")}</td>
        <td className={numericCell}>{count(ledger.steps)}</td>
        <td className={numericCell}>{count(ledger.frames)}</td>
        <td className={`${numericCell} font-normal`}>
          {metrics.cacheHit === null ? (
            <NoValue />
          ) : (
            formatRatio(metrics.cacheHit, locale)
          )}
        </td>
        <td className={numericCell}>
          {ledger.cost === null ? (
            <NoValue />
          ) : (
            <MoneyText value={ledger.cost} />
          )}
        </td>
        <td className={`${numericCell} whitespace-normal font-normal text-dim`}>
          {metrics.cost === null ? (
            <NoValue />
          ) : (
            t("ofRecorded", { cost: money(metrics.cost) })
          )}
        </td>
        <td className={cell} />
      </tr>
    </Table>
  );
}

export function WaterfallPanel({
  metrics,
  ledger,
  turns,
}: {
  metrics: RunMetrics;
  /** Null when `turns` failed. */
  ledger: Ledger | null;
  /** The `get_run_turns` read the ledger was summed from, for its failure and its end. */
  turns: Read<RunTurns>;
}) {
  const t = useTranslations("run.waterfall");
  const tCost = useTranslations("run.cost");
  const locale = useLocale();
  const { cost } = metrics;
  return (
    <Panel
      title={t("title")}
      testId="waterfall-panel"
      flush
      aside={
        ledger === null ? undefined : (
          <Badge tone="quiet" dot={false}>
            {cost === null
              ? t("asideTurns", { turns: ledger.rows.length })
              : t("aside", {
                  turns: ledger.rows.length,
                  cost: formatMoney(cost, { locale, precision: "cents" }),
                  basis: cost.basis ?? tCost("basisNotRecorded"),
                })}
          </Badge>
        )
      }
    >
      {!turns.ok || ledger === null ? (
        <PanelBody>
          {turns.ok ? null : <ReadFailure read={turns} section={t("title")} />}
        </PanelBody>
      ) : ledger.rows.length === 0 ? (
        <PanelBody>
          <p
            data-testid="waterfall-empty"
            className="m-0 max-w-prose text-sm text-muted-foreground"
          >
            {t("empty")}
          </p>
        </PanelBody>
      ) : (
        <>
          <PanelBody>
            {ledger.cost === null ? (
              <p
                data-testid="waterfall-unpriced"
                className="m-0 max-w-prose text-[12.5px] text-muted-foreground"
              >
                {/* No total means either no turn carried a cost, or the
                    turns carry more than one currency and no sum spans
                    them. The rows below show which, so the line says it. */}
                {ledger.rows.some((row) => row.cost !== null)
                  ? t("mixedCurrency")
                  : t("unpriced")}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Chart ledger={ledger} total={ledger.cost} />
                </div>
                <div className={chartLegend}>
                  <span className="inline-flex items-center gap-[5px]">
                    <i aria-hidden="true" className={swatch} />
                    {t("turnCost")}
                  </span>
                  <span className="inline-flex items-center gap-[5px]">
                    <i aria-hidden="true" className={dashKey} />
                    {t("soFar")}
                  </span>
                </div>
                <p className={caption}>
                  {t("caption", {
                    total: formatMoney(ledger.cost, {
                      locale,
                      precision: "cents",
                    }),
                  })}
                </p>
              </>
            )}
          </PanelBody>
          <div className="border-t border-border">
            <LedgerTable metrics={metrics} ledger={ledger} />
          </div>
          {turns.value.complete ? null : (
            <PanelBody rule>
              <p
                data-testid="waterfall-cut"
                className="m-0 max-w-prose text-[11.5px] text-muted-foreground"
              >
                {t("cut", { count: ledger.rows.length })}
              </p>
            </PanelBody>
          )}
        </>
      )}
    </Panel>
  );
}
