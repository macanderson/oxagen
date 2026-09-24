/**
 * invoice-copy.ts: the words on an Oxagen invoice line.
 *
 * Two invoice paths print lines a finance team reads: the prepaid order
 * (prepaid-orders.ts) and the governed-action settlement (gau-settlements.ts).
 * Both format money, a per-1,000 rate and a service period the same way, so
 * the helpers live here once. Nothing here reads a store or calls a provider.
 *
 * Conventions:
 *   - Money is in minor units of the currency, formatted en-US with the
 *     currency's own symbol and decimals: 12_000_000 usd → "$120,000.00".
 *   - A period is half-open, `[start, end)`, the way every period in billing
 *     is stored. The printed last day is the day before `end`, so a year
 *     stored as 1 Oct 2026 → 1 Oct 2027 prints "1 Oct 2026 to 30 Sep 2027".
 *     Dates are UTC.
 *   - No dashes as separators (clear-prose): "to" joins a range, a colon
 *     joins a label to its detail.
 *
 * Not exported from the package barrel: its only callers are in this package.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A half-open period, `[start, end)`. */
export interface InvoicePeriod {
  start: Date;
  end: Date;
}

function currencyFormat(
  currency: string,
  fractionDigits?: { min: number; max: number },
): Intl.NumberFormat {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    ...(fractionDigits
      ? {
          minimumFractionDigits: fractionDigits.min,
          maximumFractionDigits: fractionDigits.max,
        }
      : {}),
  });
}

/** Decimal places of the currency's minor unit: 2 for usd, 0 for jpy. */
function minorDigits(currency: string): number {
  return currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Minor units as money: `formatMoney(500_000, "usd")` → "$5,000.00". */
export function formatMoney(minor: number | bigint, currency: string): string {
  const digits = minorDigits(currency);
  return currencyFormat(currency).format(Number(minor) / 10 ** digits);
}

/**
 * The price of 1,000 units at a per-GAU rate in micro-units of the currency:
 * `3_000n` micros per GAU is $0.003 each, printed "$3.00 per 1,000". Up to
 * three decimals, because a micro-unit rate times 1,000 is exact in thousandths.
 */
export function formatRatePerThousand(
  ratePerGauMicros: bigint,
  currency: string,
): string {
  const major = Number(ratePerGauMicros) / 1_000;
  const digits = minorDigits(currency);
  return `${currencyFormat(currency, { min: digits, max: Math.max(digits, 3) }).format(major)} per 1,000`;
}

/** A whole number with thousands separators: 2000000 → "2,000,000". */
export function formatCount(n: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function day(d: Date): { d: number; m: string; y: number } {
  return {
    d: d.getUTCDate(),
    m: MONTHS[d.getUTCMonth()]!,
    y: d.getUTCFullYear(),
  };
}

/** The last instant inside a half-open period. */
function lastInstant(period: InvoicePeriod): Date {
  return new Date(Math.max(period.start.getTime(), period.end.getTime() - 1));
}

/**
 * A half-open period as a printed range of days:
 *   same day   → "1 Sep 2026"
 *   same year  → "1 Sep to 30 Sep 2026"
 *   two years  → "1 Oct 2026 to 30 Sep 2027"
 */
export function formatPeriod(period: InvoicePeriod): string {
  const a = day(period.start);
  const b = day(lastInstant(period));
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${a.d} ${a.m} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${a.m} to ${b.d} ${b.m} ${b.y}`;
  return `${a.d} ${a.m} ${a.y} to ${b.d} ${b.m} ${b.y}`;
}

/**
 * The period as the provider's line period: Unix seconds, with the end moved
 * to the last second inside the period so the provider prints the same last
 * day as {@link formatPeriod}.
 */
export function providerPeriodSeconds(period: InvoicePeriod): {
  start: number;
  end: number;
} {
  const start = Math.floor(period.start.getTime() / 1000);
  const end = Math.max(start, Math.ceil(period.end.getTime() / 1000) - 1);
  return { start, end };
}
