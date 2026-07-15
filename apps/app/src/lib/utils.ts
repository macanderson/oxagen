import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Compact currency for balances that can grow large — the nav credit pill and
 * the chat session drawer's wallet row. Small balances keep full cent precision
 * (they're read exactly), while large balances abbreviate ($12.3K, $1.2M, $3.4B)
 * so a big credit total never dominates the surface. Where the exact figure
 * matters to assistive tech, pair this with the precise `formatCents` in an
 * aria-label.
 */
export function formatCentsCompact(cents: number, currency = "USD"): string {
  if (!Number.isFinite(cents)) return formatCents(0, currency);
  const dollars = cents / 100;
  // Below $1,000 the full "$1,234.56" fits comfortably and every cent matters.
  if (Math.abs(dollars) < 1000) return formatCents(cents, currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(dollars);
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

/** Date + time, e.g. "Jan 5, 2026, 02:03 PM". "—" for null/undefined/invalid. */
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Date + time + seconds, e.g. "Jan 5, 2026, 02:03:07 PM". "—" for null/undefined/invalid. */
export function formatDateTimeWithSeconds(
  d: Date | string | null | undefined,
): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** Human-readable byte count (B / KB / MB / GB), one decimal place. */
export function formatBytes(bytes: number): string {
  // A missing/NaN/Infinity size must never render as "NaN GB".
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Truncate a string to at most `max` characters, appending an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Human duration from milliseconds: "800ms", "1.5s", "2m 5s".
 *
 * The canonical duration formatter (chat tool cards, traces, trays).
 * Two surfaces intentionally keep their own distinct display formats:
 * activity/format.ts (2-decimal seconds + "—" for null) and
 * ci-status-summary.tsx (mm:ss clock style).
 */
export function formatDuration(ms: number): string {
  // A missing/NaN/Infinity duration must never render as the literal "NaNm NaNs"
  // (the callers guard with `!= null`, which does NOT catch NaN, and a sandbox
  // command with no recorded duration reaches here as NaN).
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}
