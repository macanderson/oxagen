/**
 * Shared, framework-free formatters + status styling. Written for the
 * Activity / run-trace surface, now also used by the lineage explorer, the
 * workflows table, the repos and memories panels, and anywhere else a run
 * duration, token pair, cost, or status badge is rendered. Keep it free of
 * React and of anything server-only so either side of the boundary can call it.
 */

export type RunStatus =
  | "planning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "pending";

/**
 * Human duration from milliseconds. `—` when unknown.
 *
 * Intentionally distinct from the canonical `formatDuration` in `@/lib/utils`:
 * this surface shows 2-decimal seconds and accepts null latencies.
 */
export function formatDuration(ms: number | null): string {
  // `!Number.isFinite` also catches NaN — `ms === null` alone lets a NaN latency
  // through to render as "NaNms".
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Compact token pair, e.g. "100→50". Empty string when both are null. */
export function formatTokens(
  inTok: number | null,
  outTok: number | null,
): string {
  if (inTok === null && outTok === null) return "";
  return `${inTok ?? 0}→${outTok ?? 0}`;
}

/** Format a numeric-string USD cost, e.g. "0.012000" → "$0.0120". */
export function formatCost(usd: string | null): string | null {
  if (!usd) return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "$0";
  // Show up to 4 significant decimals for small figures.
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * Absolute timestamp label, in the viewer's locale. Returns the input string
 * unchanged when it is not a parseable date. See `timeAgo` for the relative form.
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Coarse relative "time ago" for list rows.
 *
 * Past timestamps only — a future `iso` produces a negative label ("-4m ago").
 * Callers rendering a scheduled/next-run time must not use this.
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/**
 * Badge variant for a run/step/tool status. Maps to the coss Badge semantic
 * variants (success / warning / error / info / muted).
 */
export function statusBadgeVariant(
  status: string,
): "success" | "warning" | "error" | "info" | "muted" {
  switch (status) {
    case "completed":
      return "success";
    case "running":
    case "planning":
      return "info";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return "muted";
  }
}
