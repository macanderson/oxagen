/**
 * fanout-ui.ts — pure presentation helpers for the subagent fan-out viewer.
 *
 * Status → badge variant maps and small formatters. Kept free of React so they
 * are trivially unit-testable and shared between the list and detail surfaces.
 */
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent.fanout.list";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent.fanout.get";

export type FanoutStatus = AgentSubagentFanoutListOutput["fanouts"][number]["status"];
export type RunStatus = AgentSubagentFanoutGetOutput["runs"][number]["status"];

type BadgeVariant = "secondary" | "success" | "muted" | "info" | "warning" | "error";

// Fan-out aggregate status → badge variant + label.
export const FANOUT_BADGE: Record<FanoutStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "muted" },
  running: { label: "Running", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  partial: { label: "Partial", variant: "warning" },
  timed_out: { label: "Timed out", variant: "error" },
};

// Child-run status → badge variant + label.
export const RUN_BADGE: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "muted" },
  running: { label: "Running", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
};

// A fan-out is still moving while pending/running — used to decide whether the
// viewer keeps polling.
export function isFanoutLive(status: FanoutStatus): boolean {
  return status === "pending" || status === "running";
}

// Human-friendly duration. null when the run hasn't finished.
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

// Compact byte size for the input/output columns.
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// "1 / 3" style progress label for a fan-out row.
export function progressLabel(completed: number, total: number): string {
  return `${completed} / ${total}`;
}

// Relative time like "5s ago" / "3m ago" — small dependency-free formatter for
// the list timestamps. Falls back to an ISO date for anything over a day.
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const delta = Math.max(0, now - then);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
