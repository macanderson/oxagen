"use client";

/**
 * sandbox-state-panel.tsx — a compact live "state" card for one durable sandbox.
 *
 * Surfaces the session's lifecycle at a glance: status, image, driver, when it
 * started, a live idle countdown-to-reap derived from `graceDeadlineAt` (ticks
 * every second while idle), a dirty (uncommitted-changes) indicator, and a
 * recovery banner when the session's work has been (or failed to be) flushed to
 * a branch. Every extended field is optional — the panel degrades to "—" rather
 * than crashing when `list_sandboxes` hasn't started returning them yet.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";

const STATUS_TONE: Record<SandboxStatus, "success" | "warning" | "secondary"> =
  {
    running: "success",
    idle: "warning",
    stopped: "secondary",
    gone: "secondary",
  };

/** Relative "started N ago" label; never throws on a bad ISO string. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

/**
 * Idle countdown-to-reap. Returns "reaping in M:SS" while an idle session's
 * grace deadline is in the future, "reaped" once it has passed, and "—" when
 * the session isn't idle or has no recorded deadline.
 */
function reapLabel(
  status: SandboxStatus,
  graceDeadlineAt: string | null | undefined,
  nowMs: number,
): string {
  if (status !== "idle" || !graceDeadlineAt) return "—";
  const deadline = new Date(graceDeadlineAt).getTime();
  if (Number.isNaN(deadline)) return "—";
  const remainMs = deadline - nowMs;
  if (remainMs <= 0) return "reaped";
  const totalSec = Math.floor(remainMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `reaping in ${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function StatItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export interface SandboxStatePanelProps {
  summary: SandboxSummary;
}

export function SandboxStatePanel({ summary }: SandboxStatePanelProps) {
  const {
    status,
    image,
    driver,
    createdAt,
    graceDeadlineAt,
    dirty,
    recoveryStatus,
    recoveryBranch,
  } = summary;

  // A 1s ticker drives the countdown, but only while there's actually a live
  // idle deadline to count down — otherwise the interval is never armed.
  const countsDown = status === "idle" && Boolean(graceDeadlineAt);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!countsDown) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [countsDown, graceDeadlineAt]);

  const reap = useMemo(
    () => reapLabel(status, graceDeadlineAt, nowMs),
    [status, graceDeadlineAt, nowMs],
  );

  return (
    <section
      data-testid="sandbox-state-panel"
      className="rounded-xl border border-border bg-card p-4 text-card-foreground"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatItem label="Status">
          <Badge variant={STATUS_TONE[status]}>{status}</Badge>
        </StatItem>
        <StatItem label="Image">
          <span className="font-mono text-xs">{image}</span>
        </StatItem>
        <StatItem label="Driver">
          <span className="font-mono text-xs">{driver || "—"}</span>
        </StatItem>
        <StatItem label="Started">{relativeTime(createdAt)}</StatItem>
        <StatItem label="Reap">
          <span
            data-testid="sandbox-reap-countdown"
            className={
              reap.startsWith("reaping")
                ? "tabular-nums text-warning"
                : "tabular-nums text-muted-foreground"
            }
          >
            {reap}
          </span>
        </StatItem>
      </dl>

      {dirty === true ? (
        <p
          data-testid="sandbox-dirty-indicator"
          className="mt-3 flex items-center gap-1.5 text-xs font-medium text-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Uncommitted changes
        </p>
      ) : null}

      {recoveryStatus === "recovered" ? (
        <div
          data-testid="sandbox-recovery-banner"
          data-recovery="recovered"
          className="mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-foreground"
        >
          <GitBranch className="h-3.5 w-3.5 text-success" aria-hidden />
          <span>Work recovered to branch</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {recoveryBranch ?? "unknown"}
          </code>
        </div>
      ) : recoveryStatus === "failed" ? (
        <div
          data-testid="sandbox-recovery-banner"
          data-recovery="failed"
          role="alert"
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs font-medium text-error"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Recovery pending — manual attention needed
        </div>
      ) : null}
    </section>
  );
}

export default SandboxStatePanel;
