"use client";

/**
 * recent-runs-client.tsx — the "Recent runs" panel on the evals home.
 *
 * Runs are no longer a separate concept from datasets: the home surface shows
 * datasets AND the latest eval runs (with their results rolled up) together.
 * This panel is a compact table of the most recent runs — each row links to
 * the run detail page, the dataset cell links to the dataset detail page. A
 * small stat strip in the header gives at-a-glance totals derived from the
 * runs the RSC already fetched (no extra fetch).
 *
 * Status Badge variants + score/target/cost formatting mirror
 * run-detail-client.tsx so the two surfaces stay visually in lockstep.
 */

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { workspace } from "@/lib/routes";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";

type Run = EvalRunListOutput["runs"][number];

export interface RecentRunsClientProps {
  runs: Run[];
  /** Total live runs in scope (from the RSC) — powers the header stat strip. */
  allTimeTotal: number;
  orgSlug: string;
  workspaceSlug: string;
}

type BadgeVariant = "success" | "info" | "warning" | "error" | "muted";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: "muted",
  queued: "muted",
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

function statusVariant(status: string): BadgeVariant {
  return STATUS_VARIANT[status] ?? "muted";
}

function formatTarget(target: Run["target"]): string {
  if (target.kind === "agent") return `Agent: ${target.agentSlug ?? "—"}`;
  return target.model ? `Model: ${target.model}` : "Model: (default tier)";
}

function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function formatCost(costUsdMicros: number): string {
  return `$${(costUsdMicros / 1_000_000).toFixed(4)}`;
}

/**
 * Pass signal for a run. The list row carries only the run-level avgScore +
 * passThreshold (not per-item pass flags), so the honest signal here is
 * whether the average met the threshold — not a per-item pass *rate*. Null
 * until there's a score to compare.
 */
function passSignal(run: Run): { label: string; variant: BadgeVariant } | null {
  if (run.avgScore === null) return null;
  const passed = run.avgScore >= run.passThreshold;
  return passed
    ? { label: "Pass", variant: "success" }
    : { label: "Below", variant: "warning" };
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function truncateId(id: string, max = 14): string {
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

export function RecentRunsClient({
  runs,
  allTimeTotal,
  orgSlug,
  workspaceSlug,
}: RecentRunsClientProps) {
  const ctx = { orgSlug, workspaceSlug };

  // Derived, from the runs the RSC already fetched — no second fetch.
  const scored = runs.filter((r) => r.avgScore !== null);
  const avgRecentScore =
    scored.length > 0
      ? scored.reduce((sum, r) => sum + (r.avgScore ?? 0), 0) / scored.length
      : null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-foreground">Recent runs</h2>
        <p className="text-xs text-muted-foreground">
          The latest eval runs across every dataset, with results rolled up.
        </p>
      </div>
      <div className="flex items-center gap-5">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Runs all-time</span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {allTimeTotal.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">
            Avg score (recent)
          </span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {formatScore(avgRecentScore)}
          </span>
        </div>
      </div>
    </div>
  );

  if (runs.length === 0) {
    // Runs aren't launched from this surface — they're created inside a dataset
    // (dataset detail → launch), whose action isn't reachable from here — so
    // there's no run-creating CTA to offer. The empty state points there
    // instead, using the shared EmptyState for consistency with the rest of app.
    return (
      <section className="flex flex-col gap-4" data-testid="evals-recent-runs">
        {header}
        <EmptyState
          variant="dashed"
          icon={<FlaskConical aria-hidden="true" />}
          title="No eval runs yet"
          description="Open a dataset and launch one."
          data-testid="evals-recent-runs-empty-state"
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4" data-testid="evals-recent-runs">
      {header}
      <div
        className="overflow-x-auto rounded-lg border border-border/60"
        data-testid="evals-recent-runs-table"
      >
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Run</th>
              <th className="px-4 py-2 font-medium">Dataset</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Avg score</th>
              <th className="px-4 py-2 font-medium">Pass</th>
              <th className="px-4 py-2 font-medium">Items</th>
              <th className="px-4 py-2 font-medium">Cost</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.runId}
                className="border-b border-border/50 last:border-b-0 transition-colors hover:bg-muted/40"
                data-testid="evals-recent-run-row"
              >
                <td className="px-4 py-2">
                  <Link
                    href={workspace.evals.run(ctx, run.runId)}
                    className="font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={run.name ?? run.runId}
                  >
                    {run.name ?? truncateId(run.runId)}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={workspace.evals.dataset(ctx, run.datasetId)}
                    className="text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={run.datasetName}
                  >
                    {run.datasetName}
                  </Link>
                </td>
                <td
                  className="max-w-[220px] truncate px-4 py-2 text-muted-foreground"
                  title={formatTarget(run.target)}
                >
                  {formatTarget(run.target)}
                </td>
                <td className="px-4 py-2">
                  <Badge
                    variant={statusVariant(run.status)}
                    size="sm"
                    className="capitalize"
                  >
                    {run.status}
                  </Badge>
                </td>
                <td className="px-4 py-2 tabular-nums text-foreground">
                  {formatScore(run.avgScore)}
                </td>
                <td className="px-4 py-2">
                  {(() => {
                    const signal = passSignal(run);
                    return signal ? (
                      <Badge variant={signal.variant} size="sm">
                        {signal.label}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    );
                  })()}
                </td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                  {run.completedCount}/{run.itemCount}
                  {run.failedCount > 0 ? ` · ${run.failedCount} failed` : ""}
                </td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                  {formatCost(run.costUsdMicros)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                  {formatWhen(run.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
