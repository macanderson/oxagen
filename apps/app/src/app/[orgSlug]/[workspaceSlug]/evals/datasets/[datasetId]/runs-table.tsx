"use client";

/**
 * runs-table.tsx — server-driven table of every run executed against this
 * dataset.
 *
 * All filtering / sorting / pagination happens on the SERVER: the component
 * holds `{ since, until, status, sortBy, sortDir, page }` in state and, on any
 * change, calls listEvalRunsAction with the mapped query, then swaps the rows.
 * The first page is seeded from the RSC fetch (default filter = today) so
 * there's no load flash on mount.
 *
 *   - Date filter: a Today / 7d / 30d / All preset control (drives `since` in
 *     state — NOT the URL — and re-runs the action).
 *   - Sort: clicking a Score / Date / Model / Status header sets `sortBy` and
 *     toggles `sortDir`.
 *   - Pagination: offset/limit via ListPagination (pageCount from `total`).
 *   - Count line: "Showing N of {total} — {allTimeTotal} all-time".
 *   - Each row links to the run detail page.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ListPagination } from "@/components/lists/list-pagination";
import { workspace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import { listEvalRunsAction } from "../../actions";

type RunRow = EvalRunListOutput["runs"][number];
type SortBy = "score" | "created" | "model" | "status";
type SortDir = "asc" | "desc";
type RangeKey = "today" | "7d" | "30d" | "all";

const PAGE_SIZE = 25;

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

/** ISO `since` for a range preset, or undefined for "all". UTC-anchored. */
function sinceForRange(range: RangeKey): string | undefined {
  const now = new Date();
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  switch (range) {
    case "today":
      return new Date(utcMidnight).toISOString();
    case "7d":
      return new Date(utcMidnight - 6 * 86_400_000).toISOString();
    case "30d":
      return new Date(utcMidnight - 29 * 86_400_000).toISOString();
    case "all":
      return undefined;
  }
}

const STATUS_VARIANT: Record<
  string,
  "success" | "info" | "warning" | "error" | "muted"
> = {
  pending: "muted",
  queued: "muted",
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

function formatTarget(target: RunRow["target"]): string {
  if (target.kind === "agent") return target.agentSlug ?? "(agent)";
  return target.model ?? "(default tier)";
}

function formatScore(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/**
 * The "Items" cell: completed-of-total throughput. A per-item pass rate is NOT
 * available on a list row (only the run-level avgScore + threshold are), so we
 * never fake one here. Independent of avgScore on purpose — an in-flight run
 * has real progress to show long before it has a score.
 */
function formatItemsProgress(row: RunRow): string {
  if (row.completedCount === 0) return "—";
  return `${row.completedCount}/${row.itemCount}`;
}

function formatCost(costUsdMicros: number): string {
  return `$${(costUsdMicros / 1_000_000).toFixed(4)}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export interface RunsTableProps {
  orgSlug: string;
  workspaceSlug: string;
  datasetPublicId: string;
  initialRuns: RunRow[];
  initialTotal: number;
  initialAllTimeTotal: number;
  /** The `since` the RSC seeded the first page with (UTC midnight today). */
  initialSince: string;
}

export function RunsTable({
  orgSlug,
  workspaceSlug,
  datasetPublicId,
  initialRuns,
  initialTotal,
  initialAllTimeTotal,
}: RunsTableProps) {
  const [rows, setRows] = React.useState<RunRow[]>(initialRuns);
  const [total, setTotal] = React.useState(initialTotal);
  const [allTimeTotal, setAllTimeTotal] = React.useState(initialAllTimeTotal);

  const [range, setRange] = React.useState<RangeKey>("today");
  const [sortBy, setSortBy] = React.useState<SortBy>("created");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");
  const [page, setPage] = React.useState(1); // 1-indexed
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Skip the very first fetch — the initial props already ARE the today/created
  // /desc/page-1 result, so re-fetching on mount would be a wasted round-trip
  // and cause a flash.
  const firstRender = React.useRef(true);

  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const since = sinceForRange(range);
    void listEvalRunsAction({
      orgSlug,
      workspaceSlug,
      datasetPublicId,
      ...(since ? { since } : {}),
      sortBy,
      sortDir,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setRows(result.data.runs);
        setTotal(result.data.total);
        setAllTimeTotal(result.data.allTimeTotal);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug, datasetPublicId, range, sortBy, sortDir, page]);

  function changeRange(next: RangeKey) {
    setRange(next);
    setPage(1);
  }

  function toggleSort(next: SortBy) {
    if (sortBy === next) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(next);
      setSortDir("desc");
    }
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  return (
    <section className="flex flex-col gap-4" data-testid="evals-runs-table">
      {/* Toolbar: date presets + count */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Runs date range"
          className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
        >
          {RANGES.map((r) => {
            const selected = r.key === range;
            return (
              <button
                key={r.key}
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => changeRange(r.key)}
                data-testid={`evals-runs-range-${r.key}`}
                className={cn(
                  "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>

        <p
          className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
          data-testid="evals-runs-count"
        >
          {loading && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          )}
          <span>
            Showing {showingFrom}
            {showingTo > showingFrom ? `–${showingTo}` : ""} of {total} —{" "}
            {allTimeTotal} all-time
          </span>
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">
            No runs in this window
          </p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Widen the date range or launch a run from the Run setup tab.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Run</th>
                <SortHeader
                  label="Model"
                  active={sortBy === "model"}
                  dir={sortDir}
                  onClick={() => toggleSort("model")}
                />
                <th className="px-4 py-2 font-medium">Judge</th>
                <SortHeader
                  label="Status"
                  active={sortBy === "status"}
                  dir={sortDir}
                  onClick={() => toggleSort("status")}
                />
                <SortHeader
                  label="Score"
                  active={sortBy === "score"}
                  dir={sortDir}
                  onClick={() => toggleSort("score")}
                />
                <th className="px-4 py-2 font-medium">Items</th>
                <th className="px-4 py-2 font-medium">Cost</th>
                <SortHeader
                  label="Created"
                  active={sortBy === "created"}
                  dir={sortDir}
                  onClick={() => toggleSort("created")}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr
                  key={run.runId}
                  className="border-b border-border/50 last:border-b-0 transition-colors hover:bg-muted/40"
                  data-testid="evals-runs-row"
                >
                  <td className="px-4 py-2">
                    <Link
                      href={workspace.evals.run(
                        { orgSlug, workspaceSlug },
                        run.runId,
                      )}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {run.name ?? run.runId}
                    </Link>
                  </td>
                  <td
                    className="px-4 py-2 text-foreground"
                    title={formatTarget(run.target)}
                  >
                    {formatTarget(run.target)}
                  </td>
                  <td
                    className="px-4 py-2 text-muted-foreground"
                    title={run.judgeModel}
                  >
                    {run.judgeModel}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant={STATUS_VARIANT[run.status] ?? "muted"}
                      size="sm"
                      className="capitalize"
                    >
                      {run.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 tabular-nums text-foreground">
                    {formatScore(run.avgScore)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {formatItemsProgress(run)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {formatCost(run.costUsdMicros)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {formatDate(run.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ListPagination
        page={page}
        pageCount={pageCount}
        onPageChange={setPage}
      />
    </section>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <th
      className="px-4 py-2 font-medium"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        data-testid={`evals-runs-sort-${label.toLowerCase()}`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}
