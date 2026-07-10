"use client";

import * as React from "react";
import { RefreshCw, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CIJob {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failure" | "skipped";
  url?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
}

interface CIMonitorProps {
  jobs: CIJob[];
  branch: string;
  onRefresh?: () => void;
  isLoading?: boolean;
}

const statusIcon: Record<CIJob["status"], React.ReactNode> = {
  pending: <Clock className="size-4 text-warning" />,
  running: <RefreshCw className="size-4 text-info animate-spin" />,
  success: <CheckCircle className="size-4 text-success" />,
  failure: <AlertCircle className="size-4 text-error" />,
  skipped: <Clock className="size-4 text-muted-foreground" />,
};

// Semantic Badge variants only — never raw palette colors (THEME.md).
const statusVariant: Record<
  CIJob["status"],
  "warning-soft" | "info-soft" | "success-soft" | "error-soft" | "muted"
> = {
  pending: "warning-soft",
  running: "info-soft",
  success: "success-soft",
  failure: "error-soft",
  skipped: "muted",
};

export function CIMonitor({ jobs, branch, onRefresh, isLoading = false }: CIMonitorProps) {
  const successCount = jobs.filter((j) => j.status === "success").length;
  const failureCount = jobs.filter((j) => j.status === "failure").length;
  const runningCount = jobs.filter((j) => j.status === "running").length;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">CI/CD Pipeline</h3>
          <p className="text-xs text-muted-foreground">{branch}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh status"
        >
          <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2">
        <div className="rounded bg-muted/50 p-2 text-center">
          <p className="text-sm font-semibold">{successCount}</p>
          <p className="text-xs text-muted-foreground">Passed</p>
        </div>
        <div className="rounded bg-muted/50 p-2 text-center">
          <p className="text-sm font-semibold">{runningCount}</p>
          <p className="text-xs text-muted-foreground">Running</p>
        </div>
        <div className="rounded bg-muted/50 p-2 text-center">
          <p className="text-sm font-semibold">{failureCount}</p>
          <p className="text-xs text-muted-foreground">Failed</p>
        </div>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => (
          <a
            key={job.id}
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center justify-between rounded px-3 py-2 hover:bg-muted/50 transition-colors",
              job.url && "cursor-pointer"
            )}
            title={job.name}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {statusIcon[job.status]}
              <span className="truncate text-sm font-medium">{job.name}</span>
            </div>
            <Badge variant={statusVariant[job.status]} dot={job.status === "running"}>
              {job.status}
            </Badge>
          </a>
        ))}
      </div>

      {jobs.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-4">
          No CI jobs found
        </p>
      )}
    </div>
  );
}
