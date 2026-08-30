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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
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
            Highest-{metric === "cost" ? "spend" : "token"} models in this
            window.
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
    <Table density="compact" className="min-w-[36rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
          <TableHead className="text-right">Cached</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const sub = sublabel?.(r);
          return (
            <TableRow key={r.key}>
              <TableCell>
                <span className="font-medium text-foreground">{label(r)}</span>
                {sub ? (
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {sub}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.executions.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTokens(r.inputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTokens(r.outputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTokens(r.cachedTokens)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatUsdFromMicros(r.costMicros)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
