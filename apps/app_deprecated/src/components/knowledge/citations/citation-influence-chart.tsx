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

import { BarList, BarListSeries } from "reaviz";
import {
  orderedCounts,
  INFLUENCE_ORDER,
  type InfluenceKey,
} from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";
import { useThemeColors } from "@/lib/chart-colors";

const INFLUENCE_LABEL: Record<InfluenceKey, string> = {
  DECISIVE: "Decisive",
  CONTRIBUTING: "Contributing",
  CONSIDERED: "Considered",
  IGNORED: "Ignored",
};

// Fixed per-bar colours (not a cycled categorical order), now expressed as
// SEMANTIC tokens rather than hexes so they carry the same meaning as the rest
// of the UI: DECISIVE/CONTRIBUTING read as "useful" (success, the categorical
// slate), CONSIDERED as "recalled but not useful" (warning), IGNORED as neutral.
// See lib/chart-colors.ts for why these resolve at runtime.
const INFLUENCE_TOKENS = [
  "--success",
  "--chart-2",
  "--warning",
  "--muted-foreground",
] as const;
const INFLUENCE_FALLBACK = [
  "#2F7D4F", // --success
  "#4E6A7A", // --chart-2 (slate; was the retired indigo #4C51A8)
  "#CA6719", // --warning
  "#5F5A52", // --muted-foreground
] as const;
const INFLUENCE_COLOR_ORDER: readonly InfluenceKey[] = [
  "DECISIVE",
  "CONTRIBUTING",
  "CONSIDERED",
  "IGNORED",
];

export interface CitationInfluenceChartProps {
  byInfluence: Record<string, number>;
}

export function CitationInfluenceChart({
  byInfluence,
}: CitationInfluenceChartProps) {
  const resolved = useThemeColors(INFLUENCE_TOKENS, INFLUENCE_FALLBACK);
  const colors = Object.fromEntries(
    INFLUENCE_COLOR_ORDER.map((key, i) => [key, resolved[i] as string]),
  ) as Record<InfluenceKey, string>;
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
