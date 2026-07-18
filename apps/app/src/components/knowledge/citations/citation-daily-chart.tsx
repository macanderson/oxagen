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

import { useEffect, useMemo, useState } from "react";
import { LineChart, LineSeries, LinearXAxis, LinearYAxis } from "reaviz";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { formatDayShort } from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";

const CITATIONS_COLOR = { light: "#2a78d6", dark: "#3987e5" };
const VIOLATIONS_COLOR = { light: "#d03b3b", dark: "#e66767" };

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

export interface CitationDailyChartProps {
  daily: AgentMemoryCitationStatsOutput["daily"];
}

export function CitationDailyChart({ daily }: CitationDailyChartProps) {
  const dark = useDarkMode();
  const citationsColor = dark ? CITATIONS_COLOR.dark : CITATIONS_COLOR.light;
  const violationsColor = dark ? VIOLATIONS_COLOR.dark : VIOLATIONS_COLOR.light;

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
