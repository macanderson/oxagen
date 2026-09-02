"use client";

/**
 * dataset-detail-client.tsx — the client orchestrator for the dataset detail
 * page. Composes the header + stat/gauge row, the score charts, the runs
 * table, the run-setup launcher, and the items panel.
 *
 * The three panels below the header/charts are arranged behind an in-page tab
 * strip (local state, no navigation) so a long dataset doesn't force a lot of
 * scrolling — everything stays reachable on the one page (no drawer). The
 * charts + gauge row live above the tabs so the at-a-glance signal is always
 * visible.
 *
 * `router.refresh()` re-runs the RSC data fetch (dataset item count, the
 * seeded first page of runs, the score series) after a run starts or an item
 * is added.
 */

import * as React from "react";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import type { EvalDatasetGetOutput } from "@oxagen/oxagen/contracts/eval.dataset.get";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import type { EvalRunSeriesOutput } from "@oxagen/oxagen/contracts/eval.run.series";
import { RunsTable } from "./runs-table";
import { RunSetupPanel } from "./run-setup-panel";
import { DatasetItemsPanel } from "./dataset-items-panel";

type Dataset = EvalDatasetGetOutput["dataset"];
type DatasetItem = EvalDatasetGetOutput["items"][number];
type RunRow = EvalRunListOutput["runs"][number];

// reaviz (d3) measures the DOM — client-only, code-split off the route bundle
// so the header + tabs paint before the chart library loads. Mirrors
// run-detail-client's dynamic import of run-score-chart.
const EvalCharts = dynamic(
  () => import("./eval-charts").then((m) => m.EvalCharts),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-[260px] w-full animate-pulse rounded-lg border border-border/60 bg-muted/40"
        data-testid="evals-charts-skeleton"
      />
    ),
  },
);

const SOURCE_LABEL: Record<Dataset["source"], string> = {
  manual: "Manual",
  traces: "From traces",
};

type PanelTab = "runs" | "setup" | "items";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "setup", label: "Run setup" },
  { id: "items", label: "Items" },
];

export interface DatasetDetailClientProps {
  orgSlug: string;
  workspaceSlug: string;
  datasetPublicId: string;
  dataset: Dataset;
  initialItems: DatasetItem[];
  initialItemsCursor: string | null;
  initialRuns: RunRow[];
  initialRunsTotal: number;
  initialRunsAllTimeTotal: number;
  initialSince: string;
  series: EvalRunSeriesOutput | null;
}

/** Overall avg score across the whole series (run-weighted by runCount). */
function overallAvgScore(series: EvalRunSeriesOutput | null): number | null {
  if (!series || series.overall.length === 0) return null;
  let weighted = 0;
  let runs = 0;
  for (const b of series.overall) {
    if (b.avgScore != null && b.runCount > 0) {
      weighted += b.avgScore * b.runCount;
      runs += b.runCount;
    }
  }
  return runs > 0 ? weighted / runs : null;
}

/** Pass rate across all models in the series (run-weighted mean). */
function overallPassRate(series: EvalRunSeriesOutput | null): number | null {
  if (!series || series.byModel.length === 0) return null;
  let weighted = 0;
  let runs = 0;
  for (const m of series.byModel) {
    if (m.runCount > 0) {
      weighted += m.passRate * m.runCount;
      runs += m.runCount;
    }
  }
  return runs > 0 ? weighted / runs : null;
}

export function DatasetDetailClient({
  orgSlug,
  workspaceSlug,
  datasetPublicId,
  dataset,
  initialItems,
  initialItemsCursor,
  initialRuns,
  initialRunsTotal,
  initialRunsAllTimeTotal,
  initialSince,
  series,
}: DatasetDetailClientProps) {
  const [tab, setTab] = React.useState<PanelTab>("runs");

  const avgScore = overallAvgScore(series);
  const passRate = overallPassRate(series);
  const totalRuns = series
    ? series.overall.reduce((sum, b) => sum + b.runCount, 0)
    : 0;

  return (
    <div className="flex flex-col gap-6" data-testid="evals-dataset-detail">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">
            {dataset.name}
          </h2>
          <Badge variant="outline" size="sm">
            {SOURCE_LABEL[dataset.source]}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {dataset.slug}
          </span>
        </div>
        {dataset.description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {dataset.description}
          </p>
        ) : null}
      </div>

      {/* Stat / gauge row */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        data-testid="evals-dataset-stats"
      >
        <Stat label="Items" value={dataset.itemCount.toLocaleString()} />
        <Stat
          label="Runs (all time)"
          value={initialRunsAllTimeTotal.toLocaleString()}
        />
        <Stat
          label="Avg score"
          value={avgScore == null ? "—" : avgScore.toFixed(2)}
        />
        <Stat
          label="Pass rate"
          value={passRate == null ? "—" : `${Math.round(passRate * 100)}%`}
        />
      </div>

      {/* Charts + gauges (reaviz, client-only) */}
      <EvalCharts
        series={series}
        avgScore={avgScore}
        passRate={passRate}
        totalRuns={totalRuns}
      />

      {/* In-page tab strip — everything reachable on one page, no drawer. */}
      <div>
        <div
          role="tablist"
          aria-label="Dataset detail sections"
          className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
        >
          {TABS.map((t) => {
            const selected = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(t.id)}
                data-testid={`evals-tab-${t.id}`}
                className={
                  "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors " +
                  (selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          {tab === "runs" && (
            <RunsTable
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              datasetPublicId={datasetPublicId}
              initialRuns={initialRuns}
              initialTotal={initialRunsTotal}
              initialAllTimeTotal={initialRunsAllTimeTotal}
              initialSince={initialSince}
            />
          )}
          {tab === "setup" && (
            <RunSetupPanel
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              datasetPublicId={datasetPublicId}
            />
          )}
          {tab === "items" && (
            <DatasetItemsPanel
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              datasetPublicId={datasetPublicId}
              itemCount={dataset.itemCount}
              initialItems={initialItems}
              initialCursor={initialItemsCursor}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}
