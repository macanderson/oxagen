"use client";

/**
 * eval-charts.tsx — the ONLY module on the dataset detail route that imports
 * reaviz (d3-backed, heavy). Loaded via `next/dynamic({ ssr:false })` from
 * dataset-detail-client so the header + tabs paint immediately (mirrors
 * run-score-chart.tsx / usage-charts.tsx).
 *
 * Three views:
 *   1. Score over time — a single-series LineChart of `overall` avgScore per
 *      bucketStart (y domain [0,1]).
 *   2. Model comparison (the user's ask, "compare models on the same
 *      dataset") — a grouped multi-line LineChart from `byModel[].points`, one
 *      line per model, with a legend by model + vendor.
 *   3. Gauges — reaviz RadialGauges for avg score and pass rate.
 *
 * Colors come from the same CVD-validated dataviz palette + useDarkMode() hook
 * as usage-charts.tsx.
 */

import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  LineSeries,
  LinearXAxis,
  LinearYAxis,
  RadialGauge,
  RadialGaugeSeries,
} from "reaviz";
import type { EvalRunSeriesOutput } from "@oxagen/oxagen/contracts/eval.run.series";

type SeriesModel = EvalRunSeriesOutput["byModel"][number];

// Validated dataviz categorical slots, stepped per mode (same palette as
// usage-charts.tsx, extended to more slots for the multi-model comparison).
const SERIES_LIGHT = [
  "#2a78d6",
  "#1baf7a",
  "#eda100",
  "#c0392b",
  "#8e44ad",
  "#16a085",
] as const;
const SERIES_DARK = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#e05a4d",
  "#a569c4",
  "#1ab89a",
] as const;

/** Track the app's active theme (.dark class, or system pref when unset). */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const compute = () => {
      if (root.classList.contains("dark")) return true;
      if (root.classList.contains("light")) return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    setDark(compute());
    const obs = new MutationObserver(() => setDark(compute()));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export interface EvalChartsProps {
  series: EvalRunSeriesOutput | null;
  avgScore: number | null;
  passRate: number | null;
  totalRuns: number;
}

export function EvalCharts({
  series,
  avgScore,
  passRate,
  totalRuns,
}: EvalChartsProps) {
  const dark = useDarkMode();
  const colors = dark ? SERIES_DARK : SERIES_LIGHT;

  // Single-series: overall avg score over time. Buckets with a null avgScore
  // are dropped (no run scored in that bucket) so the line only connects real
  // points.
  const overallData = useMemo(
    () =>
      (series?.overall ?? [])
        .filter((b) => b.avgScore != null)
        .map((b) => ({
          key: new Date(b.bucketStart),
          data: b.avgScore as number,
        })),
    [series],
  );

  // Grouped multi-series: one line per model. Only models with ≥1 real point
  // are charted.
  const modelData = useMemo(
    () =>
      (series?.byModel ?? [])
        .map((m: SeriesModel) => ({
          key: m.model,
          data: m.points
            .filter((p) => p.avgScore != null)
            .map((p) => ({
              key: new Date(p.bucketStart),
              data: p.avgScore as number,
            })),
        }))
        .filter((m) => m.data.length > 0),
    [series],
  );

  const hasOverall = overallData.length > 0;
  const hasModels = modelData.length > 0;

  return (
    <div className="flex flex-col gap-4" data-testid="evals-charts">
      {/* Gauges */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <GaugeCard
          label="Avg score"
          value={avgScore}
          color={colors[0]}
          readout={avgScore == null ? "—" : avgScore.toFixed(2)}
        />
        <GaugeCard
          label="Pass rate"
          value={passRate}
          color={colors[1]}
          readout={passRate == null ? "—" : `${Math.round(passRate * 100)}%`}
        />
      </div>

      {/* Score over time */}
      <div className="rounded-lg border border-border/60 p-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Score over time
        </p>
        {hasOverall ? (
          <div style={{ height: 240, width: "100%" }}>
            <LineChart
              height={240}
              data={overallData}
              series={<LineSeries colorScheme={[colors[0]]} />}
              xAxis={<LinearXAxis type="time" />}
              yAxis={<LinearYAxis type="value" domain={[0, 1]} />}
            />
          </div>
        ) : (
          <EmptyChart label="Not enough runs yet to chart score over time." />
        )}
      </div>

      {/* Model comparison */}
      <div className="rounded-lg border border-border/60 p-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Model comparison
        </p>
        {hasModels ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
              {(series?.byModel ?? [])
                .filter((m) =>
                  modelData.some((d) => d.key === m.model),
                )
                .map((m, i) => (
                  <span key={m.model} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-[2px]"
                      style={{ backgroundColor: colors[i % colors.length] }}
                    />
                    {m.model}
                    <span className="text-muted-foreground/70">
                      ({m.vendor})
                    </span>
                  </span>
                ))}
            </div>
            <div style={{ height: 240, width: "100%" }}>
              <LineChart
                height={240}
                data={modelData}
                series={
                  <LineSeries
                    type="grouped"
                    colorScheme={[...colors]}
                  />
                }
                xAxis={<LinearXAxis type="time" />}
                yAxis={<LinearYAxis type="value" domain={[0, 1]} />}
              />
            </div>
          </div>
        ) : (
          <EmptyChart label="Run this dataset against two or more models to compare them here." />
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {totalRuns.toLocaleString()} scored run
        {totalRuns === 1 ? "" : "s"} in the charted window.
      </p>
    </div>
  );
}

function GaugeCard({
  label,
  value,
  color,
  readout,
}: {
  /** Label + testid stem. */
  label: string;
  /** 0–1 fraction, or null when there is no data. */
  value: number | null;
  color: string;
  /** Human-formatted authoritative readout (e.g. "0.87" or "87%"). */
  readout: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1 rounded-lg border border-border/60 p-4"
      data-testid={`evals-gauge-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {value == null ? (
        <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
          No data yet
        </div>
      ) : (
        // RadialGauge draws the 0–1 arc; the reaviz value-label prints the raw
        // fraction which isn't always the format we want (e.g. a pass rate
        // reads better as a %), so we suppress it (valueLabel={null}) and
        // overlay our own crisp readout in the centre.
        <div className="relative" style={{ height: 160, width: "100%" }}>
          <RadialGauge
            data={[{ key: label, data: value }]}
            minValue={0}
            maxValue={1}
            height={160}
            series={
              <RadialGaugeSeries colorScheme={[color]} valueLabel={null} />
            }
          />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums text-foreground">
            {readout}
          </span>
        </div>
      )}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
