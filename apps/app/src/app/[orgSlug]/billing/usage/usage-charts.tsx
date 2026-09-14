"use client";

/**
 * reaviz charts for the usage dashboard. Loaded client-only (dynamic ssr:false
 * from the breakdown view) — reaviz measures the DOM, so it must not run during
 * SSR. Colours are the THEME's categorical ramp (--chart-1..3), resolved at
 * runtime so they flip with the theme; a legend + direct values satisfy
 * the relief rule for the sub-3:1 light slots.
 */

import {
  StackedBarChart,
  StackedBarSeries,
  BarList,
  BarListSeries,
  LinearYAxis,
  LinearYAxisTickSeries,
  LinearYAxisTickLabel,
} from "reaviz";
import type { UsageTimePoint, UsageBreakdownRow } from "@oxagen/telemetry";
import { useChartSeriesColors } from "@/lib/chart-colors";
import { formatDayShort, formatTokens } from "./usage-format";

export type UsageMetric = "cost" | "tokens";

const TOKEN_LEGEND = [
  { label: "Input", i: 0 },
  { label: "Output", i: 1 },
  { label: "Cached", i: 2 },
] as const;

export function DailyUsageChart({
  series,
  metric,
}: {
  series: UsageTimePoint[];
  metric: UsageMetric;
}) {
  const colors = useChartSeriesColors();

  if (series.length === 0) {
    return <EmptyChart label="No usage recorded in this window yet." />;
  }

  const data =
    metric === "tokens"
      ? series.map((p) => ({
          key: formatDayShort(p.day),
          data: [
            { key: "Input", data: p.inputTokens },
            { key: "Output", data: p.outputTokens },
            { key: "Cached", data: p.cachedTokens },
          ],
        }))
      : series.map((p) => ({
          key: formatDayShort(p.day),
          data: [{ key: "Cost", data: Math.round(p.costMicros) / 1_000_000 }],
        }));

  const colorScheme = metric === "tokens" ? [...colors] : [colors[0]];

  // Format y-axis ticks so labels never collide. reaviz spaces ticks evenly by
  // pixel; over a small cost range (e.g. $0–$0.35) a 1-decimal default renders
  // duplicate rounded labels (0.3, 0.3, 0.3…). Cost ticks get 2-decimal dollars
  // (always unique), tokens get the compact "1.2K" form.
  const formatTick = (value: number | string): string => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    return metric === "cost" ? `$${n.toFixed(2)}` : formatTokens(n);
  };

  return (
    <div className="flex flex-col gap-3">
      {metric === "tokens" ? (
        <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          {TOKEN_LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: colors[l.i] }}
              />
              {l.label}
            </span>
          ))}
        </div>
      ) : null}
      <div
        style={{ height: 260, width: "100%" }}
        data-testid="usage-daily-chart"
      >
        <StackedBarChart
          height={260}
          data={data}
          series={<StackedBarSeries colorScheme={colorScheme} />}
          yAxis={
            <LinearYAxis
              type="value"
              tickSeries={
                <LinearYAxisTickSeries
                  tickSize={45}
                  label={<LinearYAxisTickLabel format={formatTick} />}
                />
              }
            />
          }
        />
      </div>
    </div>
  );
}

export function TopModelsChart({
  byModel,
  metric,
}: {
  byModel: UsageBreakdownRow[];
  metric: UsageMetric;
}) {
  const colors = useChartSeriesColors();

  if (byModel.length === 0) {
    return <EmptyChart label="No model usage recorded in this window yet." />;
  }

  const data = byModel.slice(0, 8).map((r) => ({
    key: r.key,
    data:
      metric === "cost"
        ? Math.round(r.costMicros) / 1_000_000
        : r.inputTokens + r.outputTokens,
  }));

  return (
    <div style={{ width: "100%" }} data-testid="usage-models-chart">
      <BarList
        data={data}
        series={<BarListSeries colorScheme={[colors[0]]} />}
      />
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
