// The one module that turns a number into text (INV-09): money through
// <Money> (./money.tsx), counts through formatCount, clock durations through
// formatClock, ratios through formatRatio. Micros never pass through a float:
// the integer string is split into whole and fractional units as text and
// handed to Intl.NumberFormat as an exact decimal string, which it formats
// without converting to a double.
import type { Money } from "@/data/contracts/money";

/**
 * `cents`: the currency's minor units, rounded half-even once (spec §12.3).
 * `exact`: up to six fractional digits, trimmed to the last non-zero, at least two.
 */
export type MoneyPrecision = "cents" | "exact";

const MICROS = /^(-?)(\d+)$/;

function isDecimal(value: string): value is Intl.StringNumericLiteral {
  return /^-?\d+\.\d+$/.test(value);
}

function isWhole(value: string): value is Intl.StringNumericLiteral {
  return /^\d+$/.test(value);
}

/** "-1500000" → "-1.500000"; throws on anything but an integer string. */
function microsToDecimal(micros: string): Intl.StringNumericLiteral {
  const match = MICROS.exec(micros);
  if (match === null) {
    throw new Error(`money micros must be an integer string: ${micros}`);
  }
  const [, sign = "", digits = ""] = match;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-6);
  const zero = /^0+$/.test(digits);
  const decimal = `${zero ? "" : sign}${whole}.${fraction}`;
  if (!isDecimal(decimal)) throw new Error(`unformattable micros: ${micros}`);
  return decimal;
}

export function formatMoney(
  money: Money,
  { locale, precision }: { locale: string; precision: MoneyPrecision },
): string {
  const exact =
    precision === "exact"
      ? { minimumFractionDigits: 2, maximumFractionDigits: 6 }
      : {};
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    roundingMode: "halfEven",
    ...exact,
  }).format(microsToDecimal(money.micros));
}

/** A count (GAUs, blocks, runs) in the viewer's locale. */
export function formatCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    count,
  );
}

/**
 * A whole count the source recorded as digits, formatted from the string so a
 * figure past what a double holds exactly is printed as recorded. The same
 * route money takes: Intl reads an integer literal without converting it.
 */
export function formatWholeUnits(digits: string, locale: string): string {
  if (!isWhole(digits)) {
    throw new Error(`a count must be an integer string: ${digits}`);
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    digits,
  );
}

/** Whole seconds as `m:ss`, the approval clock's reading; a negative duration reads 0:00. */
export function formatClock(seconds: number, locale: string): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = new Intl.NumberFormat(locale).format(Math.floor(total / 60));
  const rest = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
  }).format(total % 60);
  return `${minutes}:${rest}`;
}

/**
 * A 0…1 ratio as a CSS length ("42.3%") for a meter's width. A style value is
 * not prose, so it is built without a locale: a decimal comma or a narrow
 * no-break space would not be a length any browser reads.
 */
export function ratioWidth(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${String(Math.round(clamped * 1000) / 10)}%`;
}

/** A 0..1 ratio (a productive ratio, a cache hit rate) as a percentage with at most one decimal. */
export function formatRatio(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ratio);
}
