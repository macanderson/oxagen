// Pure formatting + range helpers shared by the usage dashboard's server page and
// its client breakdown view. No "use client" — safe to import from either side.

export type UsageRangeKey = "7d" | "30d" | "90d" | "mtd";

export const USAGE_RANGES: ReadonlyArray<{
  key: UsageRangeKey;
  label: string;
}> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "mtd", label: "Month to date" },
];

export const DEFAULT_RANGE: UsageRangeKey = "30d";

export function parseRange(value: string | undefined): UsageRangeKey {
  return USAGE_RANGES.some((r) => r.key === value)
    ? (value as UsageRangeKey)
    : DEFAULT_RANGE;
}

/** Resolve a preset to a half-open `[start, end)` window ending at `now`. */
export function rangeToWindow(
  key: UsageRangeKey,
  now = new Date(),
): { start: Date; end: Date } {
  const end = now;
  if (key === "mtd") {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end,
    };
  }
  const days = key === "7d" ? 7 : key === "90d" ? 90 : 30;
  return { start: new Date(end.getTime() - days * 24 * 60 * 60 * 1000), end };
}

export function rangeLabel(key: UsageRangeKey): string {
  return USAGE_RANGES.find((r) => r.key === key)?.label ?? key;
}

/** Compact token count: 1_234_567 → "1.2M", 12_345 → "12.3K". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** micro-USD → "$1,234.56". 1 USD = 1_000_000 micros. */
export function formatUsdFromMicros(micros: number): string {
  const usd = micros / 1_000_000;
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usd < 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/** Short calendar-date label from a `YYYY-MM-DD` day key (UTC-safe). */
export function formatDayShort(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
