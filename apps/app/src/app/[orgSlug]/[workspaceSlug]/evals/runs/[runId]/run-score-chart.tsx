"use client";

/**
 * run-score-chart.tsx — the per-item score distribution BarChart.
 *
 * The ONLY module on the eval run-detail route that imports reaviz (d3-backed,
 * heavy). Loaded via `next/dynamic({ ssr:false })` from run-detail-client so
 * the run summary + results table paint immediately — on mobile especially,
 * the chart bundle hydrates behind a skeleton instead of blocking first paint.
 */

import { BarChart, BarSeries, LinearYAxis, LinearXAxis } from "reaviz";

export interface RunScoreChartProps {
  data: { key: string; data: number }[];
}

export function RunScoreChart({ data }: RunScoreChartProps) {
  return (
    <BarChart
      height={220}
      data={data}
      series={<BarSeries colorScheme="cybertron" />}
      xAxis={<LinearXAxis type="category" />}
      yAxis={<LinearYAxis type="value" domain={[0, 1]} />}
    />
  );
}
