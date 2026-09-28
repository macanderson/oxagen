"use client";
// The one chart kit the app draws with: shadcn's chart component from the
// base-maia registry (ADR-221, components.json), on recharts, adapted to the
// house. Every chart in the app, the assistant's included, is built from these
// pieces, so a chart reads the same wherever it appears.
//
// What changed from the registry copy, and why:
// - Series colours are CSS variables (`var(--chart-1)` to `--chart-5` in
//   globals.css), so a config carries one colour per series and no theme map.
//   The container sets them inline as `--color-<key>`. The registry's
//   <style dangerouslySetInnerHTML> is gone with the theme map.
// - The container is a named image (`role="img"` with the caller's label), and
//   recharts' own accessibility layer is off, because the data reaches
//   assistive tech through the text beside the chart or a ChartTable, never
//   through a keyboard walk of the marks.
// - The tooltip is the maia menu surface: 70% popover ground over a blurred,
//   saturated backdrop, a hairline foreground ring, and maia's radius and
//   spacing. It leads with the value and names the series only when there are
//   two or more. A value the record does not hold reads "not recorded".
// - Numbers go through the caller's formatter, or through formatDecimal
//   (INV-09). Nothing here calls toLocaleString.
// - The legend draws only for two or more series. One series is named by the
//   chart's title.
//
// Motion: recharts' Bar, Area and Line default to `isAnimationActive: "auto"`,
// which skips the entry animation under prefers-reduced-motion. Callers leave
// that default in place rather than setting it.
import { useLocale, useTranslations } from "next-intl";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useId,
} from "react";
import {
  Legend,
  type LegendPayload,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
} from "recharts";
import { formatDecimal } from "./money-format";
import { cell, headCell, numericCell } from "./table";

/** One series: the label a reader sees and its colour, a CSS variable. */
export type ChartConfig = Record<string, { label: string; color: string }>;

/** A series key is a CSS custom property name, so it keeps to these characters. */
const SERIES_KEY = /^[a-zA-Z0-9_-]+$/;

/** The size recharts draws at before the container is measured, and in tests. */
const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

const ChartContext = createContext<ChartConfig | null>(null);

function useChartConfig(): ChartConfig {
  const config = useContext(ChartContext);
  if (config === null) {
    throw new Error("a chart part must render inside <ChartContainer>");
  }
  return config;
}

/*
 * The registry's selectors: they quiet recharts' default strokes and fills
 * (#ccc, #fff) onto the house tokens and drop the focus outline recharts
 * would draw on an unfocusable surface.
 */
const RECHARTS_DEFAULTS =
  "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/60 [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-surface]:outline-hidden";

export function ChartContainer({
  config,
  label,
  className = "aspect-video",
  initialDimension = INITIAL_DIMENSION,
  children,
}: {
  config: ChartConfig;
  /** The chart's accessible name, already translated. */
  label: string;
  /** Sizing; the default is 16:9. */
  className?: string;
  initialDimension?: { width: number; height: number };
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const style: Record<string, string> = {};
  for (const [key, series] of Object.entries(config)) {
    if (SERIES_KEY.test(key)) style[`--color-${key}`] = series.color;
  }
  return (
    <ChartContext.Provider value={config}>
      <div
        role="img"
        aria-label={label}
        data-slot="chart"
        data-chart={`chart-${id}`}
        style={style as CSSProperties}
        className={`flex min-w-0 justify-center text-xs tabular-nums ${RECHARTS_DEFAULTS} ${className}`}
      >
        <ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/** The hairline grid: horizontal rules only, recessive. */
export const chartGrid = {
  vertical: false,
  stroke: "var(--chart-grid)",
} as const;

/** Axes carry no line and no tick marks; the grid and the labels do the work. */
export const chartAxis = {
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
} as const;

/** The crosshair on a line or area chart. */
export const chartCrosshair = {
  stroke: "var(--chart-baseline)",
  strokeWidth: 1,
} as const;

export const ChartTooltip = Tooltip;

/*
 * The maia menu surface: translucent ground, the blur on a ::before layer so
 * the text above it stays sharp, a hairline ring rather than a border.
 */
const TOOLTIP_SURFACE =
  "relative isolate grid min-w-32 gap-1.5 rounded-xl bg-popover/70 px-3 py-2 text-xs text-popover-foreground shadow-2xl ring-1 ring-foreground/5 dark:ring-foreground/10 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150";

/**
 * The tooltip body. recharts clones it with the hovered point's payload, so
 * every prop is optional.
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  formatValue,
  formatLabel,
}: Partial<Pick<TooltipContentProps, "active" | "payload" | "label">> & {
  /** Formats one plotted value; `row` is the data row the point came from. */
  formatValue?: (value: number, key: string, row: unknown) => ReactNode;
  /** Formats the category (a day, a tool name); defaults to the label as given. */
  formatLabel?: (label: string | number, row: unknown) => ReactNode;
}) {
  const config = useChartConfig();
  const locale = useLocale();
  const t = useTranslations("ui.chart");
  const entries = (payload ?? []).filter((entry) => entry.type !== "none");
  if (active !== true || entries.length === 0) return null;
  const several = entries.length > 1;
  const row: unknown = entries[0]?.payload;
  return (
    <div data-slot="chart-tooltip" className={TOOLTIP_SURFACE}>
      {label === undefined ? null : (
        <div className="font-medium text-foreground">
          {formatLabel ? formatLabel(label, row) : label}
        </div>
      )}
      <div className="grid gap-1">
        {entries.map((entry) => {
          const key = String(entry.dataKey ?? entry.name ?? "value");
          const value = typeof entry.value === "number" ? entry.value : null;
          return (
            <div key={key} className="flex items-center gap-2">
              {several ? (
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: entry.color }}
                />
              ) : null}
              {value === null ? (
                <span className="text-muted-foreground">
                  {t("notRecorded")}
                </span>
              ) : (
                <span className="font-mono font-medium text-foreground tabular-nums">
                  {formatValue
                    ? formatValue(value, key, entry.payload)
                    : formatDecimal(value, locale)}
                </span>
              )}
              {several ? (
                <span className="text-muted-foreground">
                  {config[key]?.label ?? key}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ChartLegend = Legend;

/** The legend: a swatch and the series label, drawn only for two or more series. */
export function ChartLegendContent({
  payload,
}: {
  payload?: ReadonlyArray<LegendPayload>;
}) {
  const config = useChartConfig();
  const items = (payload ?? []).filter((item) => item.type !== "none");
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3 text-muted-foreground">
      {items.map((item) => {
        const key = String(item.dataKey ?? item.value ?? "");
        return (
          <li key={key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: item.color }}
            />
            {config[key]?.label ?? item.value}
          </li>
        );
      })}
    </ul>
  );
}

type ChartTableColumn = { label: string; numeric?: boolean };
type ChartTableRow = { key: string; cells: readonly ReactNode[] };

/**
 * The chart's figures as a table, behind a disclosure under the chart. The
 * first cell of each row heads it. One header row, so the phone's card tables
 * label it like any other table.
 */
export function ChartTable({
  label,
  columns,
  rows,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ChartTableColumn[];
  rows: readonly ChartTableRow[];
}) {
  const t = useTranslations("ui.chart");
  return (
    <details data-slot="chart-table" className="text-[12.5px]">
      <summary className="cursor-pointer px-4 py-2 text-muted-foreground select-none hover:text-foreground">
        {t("table")}
      </summary>
      <div className="min-w-0 overflow-x-auto">
        <table aria-label={label} className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  className={`${headCell} ${column.numeric ? "text-right" : "text-left"}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                {row.cells.map((value, index) =>
                  index === 0 ? (
                    <th
                      // eslint-disable-next-line @eslint-react/no-array-index-key -- a cell's place in its row is its column, which is its identity
                      key={index}
                      scope="row"
                      className={`${cell} text-left font-normal`}
                    >
                      {value}
                    </th>
                  ) : (
                    <td
                      // eslint-disable-next-line @eslint-react/no-array-index-key -- a cell's place in its row is its column, which is its identity
                      key={index}
                      className={
                        columns[index]?.numeric === true ? numericCell : cell
                      }
                    >
                      {value}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
