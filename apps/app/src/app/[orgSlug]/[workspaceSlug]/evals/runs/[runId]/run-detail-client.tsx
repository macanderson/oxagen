"use client";

/**
 * run-detail-client.tsx — renders one eval run's summary + per-item results.
 *
 * The summary card surfaces status, avg score, pass rate (derived from the
 * per-item `passed` flags — cheaper than trusting scoreBreakdown to carry a
 * specific key), judge model, and target. The results table lists each
 * item's judge scores, pass/fail, latency, tokens, and cost — the exact
 * fields the ClickHouse metering pipe already captured for billing. A small
 * reaviz BarChart of per-item scores gives an at-a-glance score distribution.
 */

import dynamic from "next/dynamic";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EvalRunGetOutput } from "@oxagen/oxagen/contracts/eval.run.get";

type Run = EvalRunGetOutput["run"];
type Result = EvalRunGetOutput["results"][number];

export interface RunDetailClientProps {
  run: Run | null;
  results: Result[];
}

// reaviz (d3) measures the DOM — client-only, code-split off the route bundle
// so the summary + results table paint before the chart library loads.
const RunScoreChart = dynamic(
  () => import("./run-score-chart").then((m) => m.RunScoreChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[220px] w-full animate-pulse rounded-md bg-muted/50" />
    ),
  },
);

const STATUS_VARIANT: Record<
  Run["status"],
  "success" | "info" | "warning" | "error" | "muted"
> = {
  pending: "muted",
  queued: "muted",
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

function formatTarget(target: Run["target"]): string {
  if (target.kind === "agent") return `Agent: ${target.agentSlug}`;
  return target.model ? `Model: ${target.model}` : "Model: (default tier)";
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

function formatCost(costUsdMicros: number): string {
  return `$${(costUsdMicros / 1_000_000).toFixed(4)}`;
}

function truncateId(id: string, max = 12): string {
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

export function RunDetailClient({ run, results }: RunDetailClientProps) {
  if (!run) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-12 text-center"
        data-testid="eval-run-empty-state"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <FlaskConical
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">Run not found</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            This eval run doesn&apos;t exist, or you don&apos;t have access to
            it.
          </p>
        </div>
      </div>
    );
  }

  const passedCount = results.filter((r) => r.passed).length;
  const passRate =
    results.length > 0 ? (passedCount / results.length) * 100 : null;
  const scoreBreakdownEntries = Object.entries(run.scoreBreakdown);

  const chartData = results.map((r, i) => ({
    key: `#${i + 1}`,
    data: r.score,
  }));

  return (
    <div className="flex flex-col gap-5" data-testid="eval-run-detail">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 p-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <Badge
            variant={STATUS_VARIANT[run.status]}
            size="sm"
            className="w-fit capitalize"
          >
            {run.status}
          </Badge>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Avg score</span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {run.avgScore === null ? "—" : formatScore(run.avgScore)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Pass rate</span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {passRate === null
              ? "—"
              : `${passRate.toFixed(0)}% (${passedCount}/${results.length})`}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Judge model</span>
          <span
            className="truncate text-sm font-medium text-foreground"
            title={run.judgeModel}
          >
            {run.judgeModel}
          </span>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs text-muted-foreground">Target</span>
          <span className="text-sm font-medium text-foreground">
            {formatTarget(run.target)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Pass threshold</span>
          <span className="text-sm font-medium tabular-nums text-foreground">
            {run.passThreshold.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Items</span>
          <span className="text-sm font-medium tabular-nums text-foreground">
            {run.completedCount}/{run.itemCount} completed
            {run.failedCount > 0 ? `, ${run.failedCount} failed` : ""}
          </span>
        </div>
        {scoreBreakdownEntries.length > 0 && (
          <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-4">
            <span className="text-xs text-muted-foreground">
              Score breakdown
            </span>
            <div className="flex flex-wrap gap-1.5">
              {scoreBreakdownEntries.map(([key, value]) => (
                <Badge key={key} variant="outline" size="sm">
                  {key}: {formatScore(value)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Score distribution chart */}
      {chartData.length > 0 && (
        <div
          className="rounded-lg border border-border/60 p-4"
          data-testid="eval-run-score-chart"
        >
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Per-item scores
          </p>
          <div style={{ height: 220 }}>
            <RunScoreChart data={chartData} />
          </div>
        </div>
      )}

      {/* Per-item results */}
      {results.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">
            No item results yet
          </p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Results land here once the run has processed at least one item.
          </p>
        </div>
      ) : (
        <div
          className="overflow-x-auto rounded-lg border border-border/60"
          data-testid="eval-run-results-table"
        >
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">Correctness</th>
                <th className="px-4 py-2 font-medium">Faithfulness</th>
                <th className="px-4 py-2 font-medium">Passed</th>
                <th className="px-4 py-2 font-medium">Latency</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, i) => (
                <tr
                  key={result.itemId}
                  className="border-b border-border/50 last:border-b-0 transition-colors hover:bg-muted/40"
                >
                  <td
                    className="px-4 py-2 font-mono text-xs text-muted-foreground"
                    title={result.itemId}
                  >
                    #{i + 1} · {truncateId(result.itemId)}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-foreground">
                    {formatScore(result.score)}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">
                    {formatScore(result.correctness)}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">
                    {formatScore(result.faithfulness)}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant={result.passed ? "success" : "error"}
                      size="sm"
                    >
                      {result.passed ? "Passed" : "Failed"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {result.latencyMs.toLocaleString()} ms
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {result.inputTokens.toLocaleString()} in /{" "}
                    {result.outputTokens.toLocaleString()} out
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {formatCost(result.costUsdMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
