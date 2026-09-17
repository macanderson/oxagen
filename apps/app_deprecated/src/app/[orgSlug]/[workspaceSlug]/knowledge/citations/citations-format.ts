/**
 * citations-format.ts — pure helpers for the Knowledge → Citations dashboard.
 *
 * Kept dependency-free (no React) so it's cheaply unit-testable: the day-range
 * preset parser, the fixed display order for the influence/compliance enums
 * (agent.memory_citation.stats returns them as unordered records — see
 * packages/oxagen/src/contracts/agent.memory_citation.stats.ts), and the
 * daily-series date formatter.
 */

export const DAY_PRESETS = [7, 30, 90] as const;
export type DayPreset = (typeof DAY_PRESETS)[number];

/** Parse the `?days=` search param to one of the supported presets, defaulting to 30. */
export function parseDays(raw: string | string[] | undefined): DayPreset {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (DAY_PRESETS as readonly number[]).includes(n) ? (n as DayPreset) : 30;
}

// Fixed display order — DECISIVE/CONTRIBUTING are "useful" citations,
// CONSIDERED/IGNORED were recalled but did not shape the outcome. Charting a
// z.record() output in insertion order would make the bar order
// nondeterministic across responses; this pins it.
export const INFLUENCE_ORDER = [
  "DECISIVE",
  "CONTRIBUTING",
  "CONSIDERED",
  "IGNORED",
] as const;
export type InfluenceKey = (typeof INFLUENCE_ORDER)[number];

export const COMPLIANCE_ORDER = [
  "COMPLIED",
  "DISCRETION",
  "VIOLATION",
  "NA",
] as const;
export type ComplianceKey = (typeof COMPLIANCE_ORDER)[number];

/** Project a `Record<string, number>` onto the fixed key order, defaulting missing keys to 0. */
export function orderedCounts<K extends string>(
  order: readonly K[],
  counts: Record<string, number>,
): Array<{ key: K; count: number }> {
  return order.map((key) => ({ key, count: counts[key] ?? 0 }));
}

/** "2026-07-18" → "Jul 18", for the daily citations chart's x-axis. */
export function formatDayShort(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
