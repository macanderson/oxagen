"use client";

import * as React from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  CircleDot,
  Download,
  X,
  BarChart3,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import type {
  WorkflowRunSnapshot,
  WorkflowTaskSnapshot,
} from "@oxagen/oxagen/contracts/workflow.status";

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkflowStatus = WorkflowRunSnapshot["status"];
type TaskStatus = WorkflowTaskSnapshot["status"];

interface WorkflowProgressProps {
  workflowId: string;
  orgSlug?: string;
  workspaceSlug?: string;
}

interface WorkflowData {
  workflow: WorkflowRunSnapshot;
  tasks: WorkflowTaskSnapshot[];
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  WorkflowStatus,
  { label: string; badgeClass: string; isDone: boolean }
> = {
  planning: {
    label: "Planning",
    badgeClass: "bg-info/12 text-info",
    isDone: false,
  },
  running: {
    label: "Running",
    badgeClass: "bg-primary/10 text-primary",
    isDone: false,
  },
  completed: {
    label: "Completed",
    badgeClass: "bg-success/12 text-success",
    isDone: true,
  },
  failed: {
    label: "Failed",
    badgeClass: "bg-destructive/10 text-destructive",
    isDone: true,
  },
  cancelled: {
    label: "Cancelled",
    badgeClass: "bg-muted text-muted-foreground",
    isDone: true,
  },
};

const TASK_STATUS_CONFIG: Record<
  TaskStatus,
  {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    iconClass: string;
    cellClass: string;
    label: string;
  }
> = {
  pending: {
    icon: CircleDot,
    iconClass: "text-muted-foreground/40",
    cellClass: "bg-muted/30 border-border/40",
    label: "Pending",
  },
  running: {
    icon: Loader2,
    iconClass: "text-primary animate-spin",
    cellClass: "bg-primary/5 border-primary/30",
    label: "Running",
  },
  completed: {
    icon: CheckCircle2,
    iconClass: "text-success",
    cellClass: "bg-success/12 border-success/40",
    label: "Done",
  },
  failed: {
    icon: XCircle,
    iconClass: "text-destructive",
    cellClass: "bg-destructive/5 border-destructive/20",
    label: "Failed",
  },
  cancelled: {
    icon: CircleDot,
    iconClass: "text-muted-foreground/30",
    cellClass: "bg-muted/20 border-border/30",
    label: "Cancelled",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatEta(
  completedTasks: number,
  totalTasks: number,
  startedAt: string | null,
): string {
  if (!startedAt || completedTasks === 0 || totalTasks === 0) return "—";
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const perTask = elapsed / completedTasks;
  const remaining = (totalTasks - completedTasks) * perTask;
  const s = Math.floor(remaining / 1000);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Task cell ─────────────────────────────────────────────────────────────────

function TaskCell({ task }: { task: WorkflowTaskSnapshot }) {
  const cfg = TASK_STATUS_CONFIG[task.status];
  const Icon = cfg.icon;
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      className={cn(
        "relative flex h-12 w-12 flex-shrink-0 items-center justify-center",
        "rounded-lg border transition-all",
        cfg.cellClass,
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Task ${task.taskIndex + 1}: ${task.title} — ${cfg.label}`}
      role="img"
    >
      <Icon className={cn("h-4 w-4", cfg.iconClass)} aria-hidden="true" />
      <span className="sr-only">{task.taskIndex + 1}</span>
      {hovered && (
        <div
          className={cn(
            "absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2",
            "max-w-48 rounded-md border border-border bg-popover px-2.5 py-1.5",
            "text-center text-[11px] text-popover-foreground shadow-sm",
          )}
          role="tooltip"
        >
          <span className="font-medium">#{task.taskIndex + 1}</span>{" "}
          <span className="text-muted-foreground">{task.title}</span>
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WorkflowProgress({
  workflowId,
  orgSlug = "",
  workspaceSlug = "",
}: WorkflowProgressProps): React.ReactElement {
  // The workflow status/cancel/result routes are org+workspace scoped on the
  // Hono API (`/v1/:org/:ws/workflows/:id`, plural), and apps/app has NO local
  // Next route for `/api/v1/workflow*` — so the call falls through the
  // next.config rewrite to the API. A bare `/api/v1/workflow/:id` (singular, no
  // slugs) therefore 404s ("Failed to load workflow"). Build the scoped, plural
  // URL, and only poll once the slugs are present (translate-stream injects
  // orgSlug/workspaceSlug into every render component's props).
  const baseUrl =
    orgSlug !== "" && workspaceSlug !== ""
      ? `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}/workflows/${encodeURIComponent(workflowId)}`
      : null;
  const [data, setData] = React.useState<WorkflowData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  const isDone = data ? STATUS_CONFIG[data.workflow.status].isDone : false;

  // Poll the scoped workflow status route every 3s until terminal status.
  React.useEffect(() => {
    if (!baseUrl) {
      // No org/workspace context to scope the request — surface it rather than
      // firing a slug-less request that would 404.
      setError("missing workspace context");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(baseUrl as string, {
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as WorkflowData;
        if (!cancelled) {
          setData(json);
          setError(null);
          if (!STATUS_CONFIG[json.workflow.status].isDone) {
            timer = setTimeout(poll, 3000);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load workflow status",
          );
          timer = setTimeout(poll, 5000);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseUrl]);

  async function handleCancel() {
    if (!data || isDone || cancelling || !baseUrl) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(baseUrl, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as { cancelled: boolean };
      if (result.cancelled) {
        setData((prev) =>
          prev
            ? { ...prev, workflow: { ...prev.workflow, status: "cancelled" } }
            : prev,
        );
      }
    } catch (err) {
      // Surface the failure so the user knows the workflow is still running
      // and consuming credits, rather than believing it was cancelled.
      const msg = err instanceof Error ? err.message : "Cancel request failed";
      setCancelError(msg);
    } finally {
      setCancelling(false);
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────────────

  if (!data && !error) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 space-y-4 animate-pulse">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded bg-muted" />
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="ml-auto h-5 w-16 rounded-full bg-muted" />
        </div>
        <div className="h-2 w-full rounded-full bg-muted" />
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────────

  if (error && !data) {
    return (
      <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-5">
        <p className="text-sm text-destructive">
          Failed to load workflow: {error}
        </p>
      </div>
    );
  }

  if (!data) return <></>;

  const { workflow, tasks } = data;
  const statusCfg = STATUS_CONFIG[workflow.status];
  const pct =
    workflow.totalTasks > 0
      ? Math.round((workflow.completedTasks / workflow.totalTasks) * 100)
      : 0;

  const recentCompleted = [...tasks]
    .filter((t) => t.status === "completed" || t.status === "failed")
    .sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);

  // Only the backend-provided absolute result URL is trustworthy. The old
  // client-built `/api/v1/workflow/:id/result` fallback was both slug-less and
  // pointed at a route that doesn't exist (the workflow router only serves
  // GET/DELETE `/:id`), so it always 404'd — drop it and gate the button on a
  // real resultUrl instead of shipping a download that fails.
  // `resultUrl` comes back with the workflow snapshot, so the scheme is
  // allow-listed before it becomes a download href — an unsafe value simply
  // hides the button rather than arming a `javascript:` navigation.
  const downloadUrl = safeHref(workflow.resultUrl);

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-4",
        "max-w-full",
      )}
      role="region"
      aria-label={`Workflow: ${workflow.title}`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <BarChart3
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {workflow.title}
          </p>
          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
            {workflow.goal}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
            statusCfg.badgeClass,
          )}
          aria-label={`Status: ${statusCfg.label}`}
        >
          {statusCfg.label}
        </span>
      </div>

      {/* Progress bar */}
      {workflow.totalTasks > 0 && (
        <div className="space-y-1.5">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${pct}% complete`}
          >
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                workflow.status === "failed"
                  ? "bg-destructive"
                  : workflow.status === "cancelled"
                    ? "bg-muted-foreground"
                    : "bg-primary",
                workflow.status === "running" &&
                  "animate-[shimmer_1.5s_ease-in-out_infinite]",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground text-right">
            {workflow.completedTasks} / {workflow.totalTasks} tasks
          </p>
        </div>
      )}

      {/* Metrics row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Total", value: String(workflow.totalTasks) },
          { label: "Done", value: String(workflow.completedTasks) },
          { label: "Failed", value: String(workflow.failedTasks) },
          {
            label: workflow.status === "running" ? "Elapsed" : "Duration",
            value:
              workflow.status === "running"
                ? formatElapsed(workflow.startedAt)
                : workflow.startedAt && workflow.completedAt
                  ? formatElapsed(workflow.startedAt)
                  : "—",
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-muted/40 px-3 py-2"
          >
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* ETA — only while running */}
      {workflow.status === "running" && workflow.totalTasks > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          ETA:{" "}
          {formatEta(
            workflow.completedTasks,
            workflow.totalTasks,
            workflow.startedAt,
          )}
        </div>
      )}

      {/* Agent grid */}
      {tasks.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Tasks
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tasks.map((task) => (
              <TaskCell key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      {/* Live log — last 5 completed/failed */}
      {recentCompleted.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recent
          </p>
          <ul className="space-y-1" aria-label="Recent task completions">
            {recentCompleted.map((task) => {
              const tCfg = TASK_STATUS_CONFIG[task.status];
              const Icon = tCfg.icon;
              return (
                <li key={task.id} className="flex items-center gap-2 text-xs">
                  <Icon
                    className={cn("h-3 w-3 shrink-0", tCfg.iconClass)}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">
                    #{task.taskIndex + 1}
                  </span>
                  <span className="truncate text-foreground">{task.title}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Actions */}
      {(workflow.status === "running" ||
        workflow.status === "planning" ||
        workflow.resultUrl) && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-border/50">
          {cancelError && (
            <p
              role="alert"
              data-testid="cancel-error"
              className="text-xs text-destructive"
            >
              Cancel failed: {cancelError}. The workflow is still running.
            </p>
          )}
          <div className="flex items-center gap-2">
            {(workflow.status === "running" ||
              workflow.status === "planning") && (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5",
                  "text-xs font-medium text-muted-foreground transition-colors",
                  "hover:border-destructive/40 hover:text-destructive",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
                aria-busy={cancelling}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {workflow.status === "completed" && downloadUrl && (
              <a
                href={downloadUrl}
                download
                className={cn(
                  "flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5",
                  "text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                )}
                aria-label={`Download results as ${workflow.outputFormat.toUpperCase()}`}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Download {workflow.outputFormat.toUpperCase()}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
