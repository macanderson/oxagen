"use client";
import * as React from "react";
import { Loader2, Check, CircleAlert, Clock, Ban } from "lucide-react";
import type { BackgroundTaskStatus } from "./stream-event-types";

export interface BackgroundTaskCardProps {
  taskId: string;
  kind: string;
  label?: string;
  status: BackgroundTaskStatus;
  inngestRunId?: string;
  progressPct?: number;
}

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function StatusIcon({ status }: { status: BackgroundTaskStatus }) {
  switch (status) {
    case "pending":
      return <Clock className="h-4 w-4 text-muted-foreground" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-info" />;
    case "completed":
      return <Check className="h-4 w-4 text-success" />;
    case "failed":
      return <CircleAlert className="h-4 w-4 text-destructive" />;
    case "cancelled":
      return <Ban className="h-4 w-4 text-muted-foreground" />;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function BackgroundTaskCard({
  taskId,
  kind,
  label,
  status,
  progressPct,
}: BackgroundTaskCardProps) {
  const title = label ?? kind;
  const showBar = progressPct !== undefined && status === "running";
  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 p-3 text-sm animate-in"
      data-component="background-task-card"
      data-task-id={taskId}
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <span className="font-semibold">{title}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {kind}
      </div>
      {showBar ? (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-info transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
