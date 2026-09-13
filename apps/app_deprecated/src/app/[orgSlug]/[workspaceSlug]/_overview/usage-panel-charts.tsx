"use client";

/**
 * usage-panel-charts.tsx — client-only wrapper around the billing usage reaviz
 * charts for the Overview HUD Usage panel. reaviz measures the DOM and must
 * not SSR, so DailyUsageChart/TopModelsChart are dynamically imported with
 * `ssr: false`, mirroring apps/app/src/app/[orgSlug]/billing/usage/usage-breakdown-view.tsx.
 * usage-panel.tsx (a Server Component) renders THIS file rather than importing
 * usage-charts.tsx directly, since a Server Component cannot call `dynamic(...,
 * { ssr: false })` itself.
 */

import dynamic from "next/dynamic";
import type { UsageBreakdownRow, UsageTimePoint } from "@oxagen/telemetry";

const ChartSkeleton = () => (
  <div className="h-[200px] w-full animate-pulse rounded-md bg-muted/50" />
);

const DailyUsageChart = dynamic(
  () =>
    import("../../billing/usage/usage-charts").then((m) => m.DailyUsageChart),
  { ssr: false, loading: ChartSkeleton },
);

const TopModelsChart = dynamic(
  () =>
    import("../../billing/usage/usage-charts").then((m) => m.TopModelsChart),
  { ssr: false, loading: ChartSkeleton },
);

export function UsagePanelCharts({
  series,
  byModel,
}: {
  series: UsageTimePoint[];
  byModel: UsageBreakdownRow[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Daily tokens
        </p>
        <DailyUsageChart series={series} metric="tokens" />
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Top models by cost
        </p>
        <TopModelsChart byModel={byModel} metric="cost" />
      </div>
    </div>
  );
}
