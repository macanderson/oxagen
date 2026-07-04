"use client";

/**
 * Client breakdown view for the usage dashboard. Owns the cost/tokens chart
 * toggle; renders the reaviz charts (loaded client-only) and the per-model /
 * per-surface / per-workspace tables. The tables always show every measure
 * (calls, tokens, cost) — the toggle only swaps the chart metric.
 *
 * Data is fetched server-side by page.tsx via the billing.usage.breakdown
 * capability and passed in as props; this component does no data fetching.
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import type { UsageBreakdownRow, UsageTimePoint } from "@oxagen/telemetry";
import { Panel } from "@/components/ui/panel";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import type { UsageMetric } from "./usage-charts";
import { formatTokens, formatUsdFromMicros } from "./usage-format";

// reaviz measures the DOM — load the charts client-only to avoid SSR.
const ChartSkeleton = () => (
  <div className="h-[260px] w-full animate-pulse rounded-md bg-muted/50" />
);
const DailyUsageChart = dynamic(
  () => import("./usage-charts").then((m) => m.DailyUsageChart),
  { ssr: false, loading: ChartSkeleton },
);
const TopModelsChart = dynamic(
  () => import("./usage-charts").then((m) => m.TopModelsChart),
  { ssr: false, loading: ChartSkeleton },
);

const SURFACE_LABELS: Record<string, string> = {
  api: "API",
  mcp: "MCP",
  app: "Web app",
  agent: "Agent",
  runner: "Runner",
  ingestion: "Ingestion",
  "": "Unattributed",
};

// Sentinel workspaceId for org-level events (matches ORG_ONLY_WS on the server).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export function UsageBreakdownView({
  series,
  byModel,
  bySurface,
  byWorkspace,
  workspaceNames,
}: {
  series: UsageTimePoint[];
  byModel: UsageBreakdownRow[];
  bySurface: UsageBreakdownRow[];
  byWorkspace: UsageBreakdownRow[];
  workspaceNames: Record<string, string>;
}) {
  const [metric, setMetric] = useState<UsageMetric>("cost");

  return (
    <div className="flex flex-col gap-6">
      {/* Chart metric toggle */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-foreground">Trends</p>
        <SegmentedControl
          value={metric}
          onValueChange={(v) => setMetric((v as UsageMetric) ?? "cost")}
          aria-label="Chart metric"
        >
          <SegmentedControlItem value="cost">Cost</SegmentedControlItem>
          <SegmentedControlItem value="tokens">Tokens</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={metric === "cost" ? "Daily cost" : "Daily tokens"}>
          <p className="mb-3 text-xs text-muted-foreground">
            {metric === "cost"
              ? "USD spent per day in this window."
              : "Input / output / cached tokens per day."}
          </p>
          <DailyUsageChart series={series} metric={metric} />
        </Panel>

        <Panel title={`Top models by ${metric === "cost" ? "cost" : "tokens"}`}>
          <p className="mb-3 text-xs text-muted-foreground">
            Highest-{metric === "cost" ? "spend" : "token"} models in this window.
          </p>
          <TopModelsChart byModel={byModel} metric={metric} />
        </Panel>
      </div>

      {/* Breakdown tables */}
      <Panel title="By model">
        <BreakdownTable
          rows={byModel}
          label={(r) => r.key}
          sublabel={(r) => r.provider || undefined}
          emptyLabel="No model usage recorded in this window."
        />
      </Panel>

      <Panel title="By surface">
        <BreakdownTable
          rows={bySurface}
          label={(r) => SURFACE_LABELS[r.key] ?? r.key}
          emptyLabel="No surface usage recorded in this window."
        />
      </Panel>

      <Panel title="By workspace">
        <BreakdownTable
          rows={byWorkspace}
          label={(r) =>
            workspaceNames[r.key] ??
            (r.key === ORG_ONLY_WS ? "Org-level" : "Unknown workspace")
          }
          sublabel={(r) =>
            workspaceNames[r.key] || r.key === ORG_ONLY_WS
              ? undefined
              : `${r.key.slice(0, 8)}…`
          }
          emptyLabel="No workspace usage recorded in this window."
        />
      </Panel>
    </div>
  );
}

function BreakdownTable({
  rows,
  label,
  sublabel,
  emptyLabel,
}: {
  rows: UsageBreakdownRow[];
  label: (r: UsageBreakdownRow) => string;
  sublabel?: (r: UsageBreakdownRow) => string | undefined;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 text-right font-medium">Calls</th>
            <th className="py-2 pr-4 text-right font-medium">Input</th>
            <th className="py-2 pr-4 text-right font-medium">Output</th>
            <th className="py-2 pr-4 text-right font-medium">Cached</th>
            <th className="py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sub = sublabel?.(r);
            return (
              <tr key={r.key} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-4">
                  <span className="font-medium text-foreground">{label(r)}</span>
                  {sub ? (
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                      {sub}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {r.executions.toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {formatTokens(r.inputTokens)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {formatTokens(r.outputTokens)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {formatTokens(r.cachedTokens)}
                </td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {formatUsdFromMicros(r.costMicros)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
