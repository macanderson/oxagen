"use client";
// Draws an `oxagen-chart` fence in an assistant reply: stat tiles and charts,
// with the chart kit every other page uses (@/ui/chart, ADR-221). The
// assistant gets the fence from `render_chart`, which has already checked the
// shape and the size. The reply is model output, so this parses it again,
// against the same limits (`@oxagen/oxagen/chart-spec`), and checks the length
// before JSON.parse. A block that fails either check prints as code with one
// sentence saying so, and never draws a partial chart.
//
// The figures are the model's, so the block's `source` prints under it. A
// null value is a gap in a line and "not recorded" in the table, never a zero.
// Every chart carries its table.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";
import {
  CHART_FORMAT_KINDS,
  CHART_KINDS,
  CHART_LIMITS,
} from "@oxagen/oxagen/chart-spec";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTable,
  ChartTooltip,
  ChartTooltipContent,
  chartAxis,
  chartCrosshair,
  chartGrid,
} from "@/ui/chart";
import {
  formatCompactNumber,
  formatCurrencyAmount,
  formatDecimal,
  formatDuration,
  formatRatio,
} from "@/ui/money-format";

const text = (max: number) => z.string().trim().min(1).max(max);

const formatSpec = z.object({
  kind: z.enum(CHART_FORMAT_KINDS),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

type FormatSpec = z.output<typeof formatSpec>;

/** A currency format names its code, as render_chart requires. */
function hasCurrencyCode(format: FormatSpec | undefined): boolean {
  return format?.kind !== "currency" || format.currency !== undefined;
}

// JSON holds no Infinity or NaN, so a number here is finite.
const value = z.number().nullable();

const chartSpec = z
  .object({
    title: z.string().trim().max(CHART_LIMITS.titleChars).optional(),
    source: text(CHART_LIMITS.sourceChars),
    tiles: z
      .array(
        z.object({
          label: text(CHART_LIMITS.labelChars),
          value,
          format: formatSpec.optional(),
          note: z.string().trim().max(CHART_LIMITS.noteChars).optional(),
        }),
      )
      .max(CHART_LIMITS.tiles)
      .default([]),
    charts: z
      .array(
        z.object({
          title: text(CHART_LIMITS.titleChars),
          kind: z.enum(CHART_KINDS),
          series: z
            .array(z.object({ label: text(CHART_LIMITS.labelChars) }))
            .min(1)
            .max(CHART_LIMITS.series),
          rows: z
            .array(
              z.object({
                label: text(CHART_LIMITS.labelChars),
                values: z.array(value).min(1).max(CHART_LIMITS.series),
              }),
            )
            .min(1)
            .max(CHART_LIMITS.rows),
          format: formatSpec,
          unit: z.string().trim().max(CHART_LIMITS.unitChars).optional(),
        }),
      )
      .max(CHART_LIMITS.charts)
      .default([]),
  })
  .refine(
    (spec) =>
      (spec.tiles.length > 0 || spec.charts.length > 0) &&
      spec.tiles.every((tile) => hasCurrencyCode(tile.format)) &&
      spec.charts.every(
        (chart) =>
          hasCurrencyCode(chart.format) &&
          chart.rows.every((row) => row.values.length === chart.series.length),
      ),
  );

type ChartSpec = z.output<typeof chartSpec>;
type ChartSpecChart = ChartSpec["charts"][number];

/** The spec, or null when the block is too long, not JSON, or off the shape. */
function readChartSpec(code: string): ChartSpec | null {
  const trimmed = code.trim();
  if (trimmed.length === 0 || trimmed.length > CHART_LIMITS.bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = chartSpec.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** A plain number with the chart's unit, or an amount, share, or duration. */
function formatterFor(
  format: FormatSpec | undefined,
  locale: string,
  compact: boolean,
): (value: number) => string {
  switch (format?.kind) {
    case "currency": {
      const code = format.currency;
      return code === undefined
        ? (n) => formatDecimal(n, locale)
        : (n) => formatCurrencyAmount(n, code, locale, compact);
    }
    case "percent":
      return (n) => formatRatio(n, locale);
    case "duration":
      return (n) => formatDuration(n, locale);
    default:
      return compact
        ? (n) => formatCompactNumber(n, locale)
        : (n) => formatDecimal(n, locale);
  }
}

/** A bar chart with this many rows or fewer lays its bars across, labels on the left. */
const ACROSS_MAX_ROWS = 12;
const ACROSS_ROW_PX = 28;
const TICK_CHARS = 16;

function shortTick(label: string): string {
  return label.length > TICK_CHARS ? `${label.slice(0, TICK_CHARS - 1)}…` : label;
}

function NotRecorded() {
  const t = useTranslations("ui.chart");
  return <span className="text-muted-foreground">{t("notRecorded")}</span>;
}

function Figure({
  value,
  format,
  unit,
}: {
  value: number | null;
  format: FormatSpec | undefined;
  unit?: string;
}) {
  const t = useTranslations("shell.assistant.chart");
  const locale = useLocale();
  if (value === null) return <NotRecorded />;
  const figure = formatterFor(format, locale, false)(value);
  return (
    <span className="font-mono tabular-nums">
      {unit && format?.kind === "number"
        ? t("withUnit", { value: figure, unit })
        : figure}
    </span>
  );
}

function SpecChart({ chart }: { chart: ChartSpecChart }) {
  const t = useTranslations("shell.assistant.chart");
  const locale = useLocale();
  const keys = chart.series.map((_, index) => `s${index}`);
  const config: ChartConfig = Object.fromEntries(
    chart.series.map((series, index) => [
      `s${index}`,
      { label: series.label, color: `var(--chart-${index + 1})` },
    ]),
  );
  const data = chart.rows.map((row) => ({
    label: row.label,
    ...Object.fromEntries(keys.map((key, index) => [key, row.values[index]])),
  }));
  const tick = formatterFor(chart.format, locale, true);
  const tooltip = (
    <ChartTooltip
      cursor={
        chart.kind === "line" || chart.kind === "area" ? chartCrosshair : true
      }
      content={
        <ChartTooltipContent
          formatValue={(n) => (
            <Figure value={n} format={chart.format} unit={chart.unit} />
          )}
        />
      }
    />
  );
  const legend =
    keys.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null;
  const margin = { top: 4, right: 8, bottom: 0, left: 0 };
  const across =
    (chart.kind === "bar" || chart.kind === "stacked_bar") &&
    chart.rows.length <= ACROSS_MAX_ROWS;
  const stacked = chart.kind === "stacked_bar";

  let plot: ReactNode;
  if (chart.kind === "line" || chart.kind === "area") {
    const Plot = chart.kind === "line" ? LineChart : AreaChart;
    plot = (
      <Plot data={data} accessibilityLayer={false} margin={margin}>
        <CartesianGrid {...chartGrid} />
        <XAxis
          dataKey="label"
          interval="preserveStartEnd"
          minTickGap={16}
          tickFormatter={shortTick}
          {...chartAxis}
        />
        <YAxis width={48} tickFormatter={tick} {...chartAxis} />
        {tooltip}
        {legend}
        {keys.map((key) =>
          chart.kind === "line" ? (
            <Line
              key={key}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            />
          ) : (
            <Area
              key={key}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              fill={`var(--color-${key})`}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            />
          ),
        )}
      </Plot>
    );
  } else {
    // A stacked bar rounds only the end of its last segment.
    const radius = (index: number): number | [number, number, number, number] => {
      if (!stacked) return 4;
      if (index < keys.length - 1) return 0;
      return across ? [0, 4, 4, 0] : [4, 4, 0, 0];
    };
    plot = (
      <BarChart
        data={data}
        accessibilityLayer={false}
        margin={margin}
        layout={across ? "vertical" : "horizontal"}
      >
        {across ? (
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        ) : (
          <CartesianGrid {...chartGrid} />
        )}
        {across ? (
          <>
            <XAxis type="number" tickFormatter={tick} {...chartAxis} />
            <YAxis
              type="category"
              dataKey="label"
              width={112}
              tickFormatter={shortTick}
              {...chartAxis}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="label"
              interval="preserveStartEnd"
              minTickGap={16}
              tickFormatter={shortTick}
              {...chartAxis}
            />
            <YAxis width={48} tickFormatter={tick} {...chartAxis} />
          </>
        )}
        {tooltip}
        {legend}
        {keys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            fill={`var(--color-${key})`}
            maxBarSize={24}
            radius={radius(index)}
            {...(stacked ? { stackId: "stack" } : {})}
          />
        ))}
      </BarChart>
    );
  }

  const legendPx = keys.length > 1 ? 32 : 0;
  const height = across
    ? chart.rows.length * ACROSS_ROW_PX + 32 + legendPx
    : 176 + legendPx;
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <p className="font-medium text-foreground">{chart.title}</p>
      <div className="w-full" style={{ height }}>
        <ChartContainer
          config={config}
          label={chart.title}
          className="h-full w-full"
          initialDimension={{ width: 360, height }}
        >
          {plot}
        </ChartContainer>
      </div>
      <ChartTable
        label={chart.title}
        columns={[
          { label: t("item") },
          ...chart.series.map((series) => ({
            label: series.label,
            numeric: true,
          })),
        ]}
        rows={chart.rows.map((row, index) => ({
          key: String(index),
          cells: [
            row.label,
            ...row.values.map((cell, column) => (
              <Figure
                // eslint-disable-next-line @eslint-react/no-array-index-key -- a value's place in its row is its series, which is its identity
                key={column}
                value={cell}
                format={chart.format}
                unit={chart.unit}
              />
            )),
          ],
        }))}
      />
    </div>
  );
}

/**
 * Streamdown's renderer for an `oxagen-chart` fence (assistant-markdown.tsx).
 * While the reply streams, the fence is incomplete and reads as a placeholder.
 */
export function AssistantChartBlock({
  code,
  isIncomplete,
}: {
  code: string;
  isIncomplete: boolean;
}) {
  const t = useTranslations("shell.assistant.chart");
  if (isIncomplete) {
    return (
      <p
        data-testid="assistant-chart-drawing"
        className="text-muted-foreground"
      >
        {t("drawing")}
      </p>
    );
  }
  const spec = readChartSpec(code);
  if (spec === null) {
    return (
      <div data-testid="assistant-chart-unreadable" className="grid gap-1.5">
        <p className="text-muted-foreground">{t("unreadable")}</p>
        <pre className="max-h-48 overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[12px]">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <figure
      data-testid="assistant-chart"
      className="@container my-3 grid min-w-0 gap-3 rounded-xl border border-border p-3 text-[12.5px]"
    >
      {spec.title ? (
        <figcaption className="text-[13px] font-medium text-foreground">
          {spec.title}
        </figcaption>
      ) : null}
      {spec.tiles.length > 0 ? (
        <dl className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
          {spec.tiles.map((tile, index) => (
            <div
              // eslint-disable-next-line @eslint-react/no-array-index-key -- tiles are a fixed list from one block; the place is the identity
              key={index}
              className="grid content-start gap-0.5 rounded-lg bg-muted/40 px-3 py-2"
            >
              <dt className="text-muted-foreground">{tile.label}</dt>
              <dd className="text-[17px] leading-6 text-foreground">
                <Figure value={tile.value} format={tile.format} />
              </dd>
              {tile.note ? (
                <dd className="text-[11.5px] text-muted-foreground">
                  {tile.note}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}
      {spec.charts.length > 0 ? (
        <div className="grid gap-4 @2xl:grid-cols-2">
          {spec.charts.map((chart, index) => (
            // eslint-disable-next-line @eslint-react/no-array-index-key -- charts are a fixed list from one block; the place is the identity
            <SpecChart key={index} chart={chart} />
          ))}
        </div>
      ) : null}
      <p className="text-[11.5px] text-muted-foreground">
        {t("source", { source: spec.source })}
      </p>
    </figure>
  );
}
