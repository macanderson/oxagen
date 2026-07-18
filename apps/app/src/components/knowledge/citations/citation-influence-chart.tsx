"use client";

/**
 * citation-influence-chart.tsx — horizontal bar breakdown of citations by
 * influence level (DECISIVE/CONTRIBUTING/CONSIDERED/IGNORED). Loaded
 * client-only — reaviz measures the DOM, so it must not run during SSR
 * (mirrors usage-charts.tsx / eval-charts.tsx).
 *
 * DECISIVE/CONTRIBUTING are "useful" citations (they shaped the outcome);
 * CONSIDERED/IGNORED were recalled but did not. Each bar gets its own fixed
 * color (good→neutral, not a cycled categorical palette) so the useful/
 * not-useful split reads at a glance without relying on position alone.
 */

import { useEffect, useState } from "react";
import { BarList, BarListSeries } from "reaviz";
import {
  orderedCounts,
  INFLUENCE_ORDER,
  type InfluenceKey,
} from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";

const INFLUENCE_LABEL: Record<InfluenceKey, string> = {
  DECISIVE: "Decisive",
  CONTRIBUTING: "Contributing",
  CONSIDERED: "Considered",
  IGNORED: "Ignored",
};

// Fixed per-bar colors (not a cycled categorical order) — DECISIVE/CONTRIBUTING
// read as "useful" (green/blue), CONSIDERED/IGNORED as "recalled but not
// useful" (amber/neutral).
const COLORS_LIGHT: Record<InfluenceKey, string> = {
  DECISIVE: "#0ca30c",
  CONTRIBUTING: "#2a78d6",
  CONSIDERED: "#fab219",
  IGNORED: "#a1a1aa",
};
const COLORS_DARK: Record<InfluenceKey, string> = {
  DECISIVE: "#34d399",
  CONTRIBUTING: "#3987e5",
  CONSIDERED: "#c98500",
  IGNORED: "#a1a1aa",
};

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

export interface CitationInfluenceChartProps {
  byInfluence: Record<string, number>;
}

export function CitationInfluenceChart({
  byInfluence,
}: CitationInfluenceChartProps) {
  const dark = useDarkMode();
  const colors = dark ? COLORS_DARK : COLORS_LIGHT;
  const rows = orderedCounts(INFLUENCE_ORDER, byInfluence);
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  if (total === 0) {
    return (
      <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
        No citations recorded in this window yet.
      </div>
    );
  }

  const data = rows.map((r) => ({
    key: INFLUENCE_LABEL[r.key],
    data: r.count,
  }));
  const colorScheme = rows.map((r) => colors[r.key]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        {rows.map((r) => (
          <span key={r.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: colors[r.key] }}
            />
            {INFLUENCE_LABEL[r.key]} ({r.count.toLocaleString()})
          </span>
        ))}
      </div>
      <div style={{ width: "100%" }} data-testid="citation-influence-chart">
        <BarList
          data={data}
          series={
            <BarListSeries colorScheme={colorScheme} valuePosition="end" />
          }
        />
      </div>
    </div>
  );
}
