/**
 * billing-format.ts — pure helpers for billing-related display strings.
 *
 * All functions are side-effect-free and unit-testable. Pass `opts.now`
 * explicitly in tests (and server renders) rather than relying on Date.now().
 */

/** Format a number as an ordinal day string, e.g. 1 → "1st", 11 → "11th". */
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Format a Date as "Month Dth, YYYY", e.g. "June 7th, 2026". */
function formatOrdinalDate(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${ordinal(d.getUTCDate())}, ${d.getUTCFullYear()}`;
}

export interface FormatRelativeRenewalOpts {
  /** Anchor for "now" — pass explicitly for determinism. Defaults to Date.now(). */
  now?: Date;
  /**
   * When true, replace "renews" with "cancels" — used when
   * `subscription.cancelAtPeriodEnd` is set.
   */
  cancel?: boolean;
}

/**
 * Produce a human-readable relative renewal (or cancellation) string.
 *
 * The `end` date is always included verbatim. Comparison is in UTC whole-days.
 *
 * Examples (today = 2026-06-05):
 *   0 days  → "renews today"
 *   1 day   → "renews tomorrow on June 6th, 2026"
 *   2–30d   → "renews in 3 days on June 8th, 2026"
 *   31–44d  → "renews in 1 month on July 6th, 2026"
 *   45–74d  → "renews in 2 months on August 7th, 2026"
 *   …       → "renews in N months on …"
 *
 * When `opts.cancel` is true, "renews" is replaced with "cancels".
 */
export function formatRelativeRenewal(
  end: Date | string,
  opts?: FormatRelativeRenewalOpts,
): string {
  const nowDate = opts?.now ?? new Date();
  const endDate = typeof end === "string" ? new Date(end) : end;
  const verb = opts?.cancel ? "cancels" : "renews";

  // Truncate both to UTC midnight for whole-day arithmetic.
  const nowMidnight = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  const endMidnight = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  );

  const diffMs = endMidnight - nowMidnight;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const label = formatOrdinalDate(endDate);

  if (diffDays <= 0) {
    return `${verb} today`;
  }
  if (diffDays === 1) {
    return `${verb} tomorrow on ${label}`;
  }
  if (diffDays <= 30) {
    return `${verb} in ${diffDays} days on ${label}`;
  }

  // > 30 days: switch to months, rounding days/30 (44d → 1 month, 45d → 2
  // months, 74d → 2 months, 75d → 3 months). Matches the table in the docblock.
  const months = Math.round(diffDays / 30);
  const monthLabel = months === 1 ? "1 month" : `${months} months`;
  return `${verb} in ${monthLabel} on ${label}`;
}
