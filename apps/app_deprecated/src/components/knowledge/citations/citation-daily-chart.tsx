"use client";

/**
 * citation-daily-chart.tsx — grouped two-line chart of citations vs.
 * violations per day. Loaded client-only — reaviz measures the DOM, so it
 * must not run during SSR (mirrors usage-charts.tsx / eval-charts.tsx).
 *
 * Citations uses the neutral categorical blue; violations uses the reserved
 * status "critical" red — a status color never impersonates a series, but
 * violations genuinely IS a status (a promoted rule got broken), not just
 * another metric.
 */

import { useMemo } from "react";
import { LineChart, LineSeries, LinearXAxis, LinearYAxis } from "reaviz";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { formatDayShort } from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";
import { useThemeColors } from "@/lib/chart-colors";

/**
 * Citations read as a neutral categorical series; violations are a failure
 * state and take the theme's destructive token, so they can never drift to a
 * red that means nothing in the palette. Resolved from the design tokens — see
 * lib/chart-colors.ts for why this is done at runtime rather than as hexes.
 */
const SERIES_TOKENS = ["--chart-2", "--destructive"] as const;
const SERIES_FALLBACK = ["#4E6A7A", "#DC2828"] as const;

export interface CitationDailyChartProps {
  daily: AgentMemoryCitationStatsOutput["daily"];
}

export function CitationDailyChart({ daily }: CitationDailyChartProps) {
  const [citationsColor, violationsColor] = useThemeColors(
    SERIES_TOKENS,
    SERIES_FALLBACK,
  );

  const hasData = daily.some((d) => d.citations > 0 || d.violations > 0);

  const data = useMemo(
    () => [
      {
        key: "Citations",
        data: daily.map((d) => ({
          key: formatDayShort(d.date),
          data: d.citations,
        })),
      },
      {
        key: "Violations",
        data: daily.map((d) => ({
          key: formatDayShort(d.date),
          data: d.violations,
        })),
      },
    ],
    [daily],
  );

  if (daily.length === 0 || !hasData) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        No citations recorded in this window yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: citationsColor }}
          />
          Citations
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: violationsColor }}
          />
          Violations
        </span>
      </div>
      <div
        style={{ height: 240, width: "100%" }}
        data-testid="citation-daily-chart"
      >
        <LineChart
          height={240}
          data={data}
          series={
            <LineSeries
              type="grouped"
              colorScheme={[citationsColor, violationsColor]}
            />
          }
          xAxis={<LinearXAxis type="category" />}
          yAxis={<LinearYAxis type="value" />}
        />
      </div>
    </div>
  );
}
