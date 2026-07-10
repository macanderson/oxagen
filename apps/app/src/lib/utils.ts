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
export function formatDateTimeWithSeconds(d: Date | string | null | undefined): string {
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
