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
  // Abbreviate only once the string is genuinely long. A four-figure balance
  // like "$1,003.59" costs little width, and compacting it to "$1K" would hide
  // whether the user has $1,000 or $1,499 — which is exactly what they're
  // reading the number to find out before topping up. Five figures and beyond
  // ("$12,345.67", "$1,234,567.89") is where the number starts to dominate.
  if (Math.abs(dollars) < 10_000) return formatCents(cents, currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(dollars);
}

/**
 * Whole-dollar currency for width-starved surfaces (the phone-width nav credit
 * pill). Drops cents ("$1,003") below the compact threshold and defers to
 * `formatCentsCompact` above it, so large balances still abbreviate. Pair with
 * the precise `formatCents` in an aria-label wherever the exact figure matters.
 */
export function formatCentsWhole(cents: number, currency = "USD"): string {
  if (!Number.isFinite(cents)) return formatCents(0, currency);
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 10_000) return formatCentsCompact(cents, currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
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

/**
 * First name from a Better Auth `user.name` (which stores a full display name).
 * Returns null when there's nothing usable to greet with, so callers can fall
 * back to a name-less greeting rather than rendering "Welcome, !".
 *
 * An email-looking name (some providers backfill `name` with the address) is
 * rejected: greeting someone as "Welcome, mac+local@oxagen.sh!" reads worse
 * than a plain "Welcome!".
 */
export function firstNameOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];
  if (!first || first.includes("@")) return null;
  return first;
}

/** Truncate a string to at most `max` characters, appending an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Truncate the MIDDLE of a string so both the meaningful prefix and suffix
 * survive ("oxagen.default.qa-chat-assistant" → "oxagen.defa…-assistant").
 * Preferred for dotted identifiers/keys, where a plain end-ellipsis drops the
 * distinguishing tail and reads like a typo. Head gets ~60% of the budget.
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${tail > 0 ? value.slice(value.length - tail) : ""}`;
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
