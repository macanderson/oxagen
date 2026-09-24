// Money on the wire (ARCHITECTURE.md §3.9, INV-09): integer micro-units as a
// decimal string with an ISO 4217 currency, and a metered cost carries the
// basis that says who observed it as a required key that may be null. This
// module is the one place arithmetic on micros happens, with BigInt or digit
// shifting on the string, so no figure passes through a float. Formatting is
// src/ui/money-format.ts.
import { z } from "zod";

const MICROS = /^-?\d+$/;

export const Money = z.object({
  micros: z.string().regex(MICROS),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof Money>;

/** Who observed a metered figure (spec §12.3, `cost.run_totals.cost_basis`). */
const CostBasis = z.enum([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);

/** A metered cost: money plus who observed it, `null` when nobody recorded that. */
export const Cost = Money.extend({ basis: CostBasis.nullable() });
export type Cost = z.infer<typeof Cost>;

/** A micros value that is not an integer string ("2,450.00", "1e6", ""). */
class InvalidMicrosError extends Error {
  readonly code = "invalid_micros";

  constructor(readonly micros: string) {
    super(`micros must be an integer string, got ${JSON.stringify(micros)}`);
    this.name = "InvalidMicrosError";
  }
}

/** A quantity that is not a whole number a float holds exactly. */
class InvalidQuantityError extends Error {
  readonly code = "invalid_quantity";

  constructor(readonly quantity: number) {
    super(`quantity must be a safe integer, got ${String(quantity)}`);
    this.name = "InvalidQuantityError";
  }
}

/** `BigInt("")` is 0n and `BigInt(" 12")` is 12n, so the pattern is checked first. */
function toBigInt(micros: string): bigint {
  if (!MICROS.test(micros)) throw new InvalidMicrosError(micros);
  return BigInt(micros);
}

/** A `Money` from a recorded micros string, in canonical form (no leading zeros, no `-0`). */
export function moneyFromMicros(micros: string, currency: string): Money {
  return { micros: toBigInt(micros).toString(), currency };
}

/** `value` times a whole `quantity` (GAUs in a block, blocks in a purchase), exact at any magnitude. */
export function mulMicros(value: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) throw new InvalidQuantityError(quantity);
  return {
    micros: (toBigInt(value.micros) * BigInt(quantity)).toString(),
    currency: value.currency,
  };
}

/** Tokens in the unit a price book row quotes. */
const TOKENS_PER_MILLION = BigInt(1_000_000);

/**
 * The rate per million tokens that a recorded `cost` for `tokens` works out
 * to, exact at any magnitude and truncated toward zero. It prices nothing: the
 * Run page's Prompt composition prints the effective input price this way, the
 * input classes' recorded cost over the input tokens. The app never multiplies
 * a rate by a token count; the rollup records every cost (ADR-060, #4069).
 * Null for no tokens: a price per token of nothing is not a rate anyone paid.
 */
export function perMillionTokens(cost: Money, tokens: number): Money | null {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new InvalidQuantityError(tokens);
  if (tokens === 0) return null;
  return {
    micros: (
      (toBigInt(cost.micros) * TOKENS_PER_MILLION) /
      BigInt(tokens)
    ).toString(),
    currency: cost.currency,
  };
}

/**
 * `a − b`, exact, or null when the two carry different currencies: a
 * difference across currencies is not an amount anyone saved or spent.
 */
export function subMoney(a: Money, b: Money): Money | null {
  if (a.currency !== b.currency) return null;
  return {
    micros: (toBigInt(a.micros) - toBigInt(b.micros)).toString(),
    currency: a.currency,
  };
}

/**
 * The sum of `values`, exact at any magnitude, or null when there is nothing
 * to sum or the values carry more than one currency: a total across currencies
 * is not a figure anyone was charged.
 */
export function sumMoney(values: readonly Money[]): Money | null {
  const [first] = values;
  if (first === undefined) return null;
  let total = BigInt(0);
  for (const value of values) {
    if (value.currency !== first.currency) return null;
    total += toBigInt(value.micros);
  }
  return { micros: total.toString(), currency: first.currency };
}

/**
 * `value` divided by a whole `count` (spend per call, per run, per day),
 * truncated toward zero at the micro, or null when there is nothing to divide
 * by. The division is BigInt, so the average stays exact at any magnitude.
 */
export function divMicros(value: Money, count: number): Money | null {
  if (!Number.isSafeInteger(count)) throw new InvalidQuantityError(count);
  if (count <= 0) return null;
  return {
    micros: (toBigInt(value.micros) / BigInt(count)).toString(),
    currency: value.currency,
  };
}

/** Micros in one cent. */
const MICROS_PER_CENT = BigInt(10_000);

/**
 * `value` rounded to whole cents, half to even (banker's rounding), exact at
 * any magnitude. A statement total is rounded once, here, after its lines are
 * summed at full precision (pages/billing.md, This period).
 */
export function roundToCentsHalfEven(value: Money): Money {
  const micros = toBigInt(value.micros);
  const negative = micros < BigInt(0);
  const magnitude = negative ? -micros : micros;
  let cents = magnitude / MICROS_PER_CENT;
  const rest = magnitude % MICROS_PER_CENT;
  const half = MICROS_PER_CENT / BigInt(2);
  if (rest > half || (rest === half && cents % BigInt(2) === BigInt(1))) {
    cents += BigInt(1);
  }
  const rounded = cents * MICROS_PER_CENT;
  return {
    micros: (negative && rounded !== BigInt(0) ? -rounded : rounded).toString(),
    currency: value.currency,
  };
}

/**
 * The largest of `values`, or null when there is none or they carry more than
 * one currency: the peak of a series of days is only a figure within one.
 */
export function maxMoney(values: readonly Money[]): Money | null {
  const [first] = values;
  if (first === undefined) return null;
  let peak = first;
  for (const value of values) {
    if (value.currency !== first.currency) return null;
    if (toBigInt(value.micros) > toBigInt(peak.micros)) peak = value;
  }
  return { micros: toBigInt(peak.micros).toString(), currency: peak.currency };
}

/**
 * Orders two values of one currency largest first, for a ranked list: a
 * negative number when `a` is the larger. Values in different currencies
 * compare equal, since neither is larger in any unit a person was charged.
 */
export function byMicrosDescending(a: Money, b: Money): number {
  if (a.currency !== b.currency) return 0;
  const diff = toBigInt(b.micros) - toBigInt(a.micros);
  return diff > BigInt(0) ? 1 : diff < BigInt(0) ? -1 : 0;
}

/** The precision `ratioOfMicros` divides at: a ratio carries six decimal places. */
const RATIO_SCALE = 1_000_000;

/**
 * `part ÷ whole` as a ratio, or null when the two carry different currencies
 * or `whole` is zero. The division is BigInt on the micros, scaled first, so a
 * figure past what a float holds exactly still divides where it should. The
 * answer is a ratio and never money: the caller prints it through
 * `formatRatio` (INV-09). A ratio above one or below zero is answered as
 * measured; nothing here clamps a figure the contract carried.
 */
export function ratioOfMicros(part: Money, whole: Money): number | null {
  if (part.currency !== whole.currency) return null;
  const divisor = toBigInt(whole.micros);
  if (divisor === BigInt(0)) return null;
  const scaled = (toBigInt(part.micros) * BigInt(RATIO_SCALE)) / divisor;
  return Number(scaled) / RATIO_SCALE;
}

/**
 * Orders two amounts by their micros, for a column a person sorts by cost.
 * Negative when `a` is smaller, positive when larger, zero when equal. The
 * comparison is exact on the digit strings through BigInt, so two costs a
 * float would round together still sort apart (INV-09). Amounts in different
 * currencies have no order between them, so they sort by currency code.
 */
export function compareMicros(a: Money, b: Money): number {
  if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
  const x = toBigInt(a.micros);
  const y = toBigInt(b.micros);
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * The part of `value` a `share` between 0 and 1 names: the Run page's wasted
 * spend is its cost times the share the rollup did not count as productive.
 * The share is rounded to a millionth and the micros are divided by BigInt, so
 * the money stays exact and truncates toward zero. A share outside 0 to 1
 * names no part of the value, so the answer is null and the caller shows the
 * figure as missing.
 */
export function shareOfMicros(value: Money, share: number): Money | null {
  if (!(share >= 0 && share <= 1)) return null;
  const scaled = BigInt(Math.round(share * RATIO_SCALE));
  return {
    micros: (
      (toBigInt(value.micros) * scaled) /
      BigInt(RATIO_SCALE)
    ).toString(),
    currency: value.currency,
  };
}

/**
 * The ISO 4217 codes this runtime knows, which is what "a currency code"
 * means. A mandate limit names either one of these or a unit of a count
 * (`schemas.ts`), and the two are told apart by membership here rather than by
 * spelling: `GAU` and `RPM` are well-formed three-letter units and every
 * three-letter test would read them as money, printing 50 GAU as GAU 0.00.
 * The durable answer is a kind on the wire, which belongs to the contract that
 * writes the limit; until it carries one, this is the set the contract names.
 */
const CURRENCY_CODES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency"),
);

export function isCurrencyCode(code: string): boolean {
  return CURRENCY_CODES.has(code);
}

/**
 * `part` as a fraction of `whole`, for a meter's width. The pair beside
 * `ratioOfMicros`, which answers what a figure measures and never clamps: this
 * one answers how much of a bar to fill, so it takes the bare integer strings
 * a mandate limit carries — micros for money, whole units for a count, with no
 * currency to compare — and clamps to 0…1, because a bar wider than its track
 * is not a reading. The division is BigInt, so a figure past what a double
 * holds exactly still divides where it should.
 */
export function ratioOfIntegers(part: string, whole: string): number {
  const total = toBigInt(whole);
  if (total <= 0n) return 0;
  const drawn = toBigInt(part);
  if (drawn <= 0n) return 0;
  if (drawn >= total) return 1;
  const scale = BigInt(RATIO_SCALE);
  return Number((drawn * scale) / total) / RATIO_SCALE;
}

/**
 * Whether `a` and `b` together are past `whole`, on the bare integer strings.
 * The pair to `ratioOfIntegers`, and the reason it has to exist separately:
 * that function clamps to 0…1, because a bar wider than its track is not a
 * reading — so by the time a caller holds two ratios, the fact that either
 * exceeded the whole is gone. 600 of a limit of 500 is a ratio of 1,
 * indistinguishable from exactly 500, and summing two clamped ratios cannot
 * recover it. The ratios are for drawing; this is for saying. The comparison
 * is BigInt on the digits the ledger recorded, with nothing clamped, rounded
 * or scaled before it is asked.
 */
export function sumExceeds(a: string, b: string, whole: string): boolean {
  return toBigInt(a) + toBigInt(b) > toBigInt(whole);
}

/**
 * A decimal amount a person typed ("500", "0.25", "12.000001") as integer
 * micros, or null for anything else: a sign, a grouping separator, more than
 * six fractional digits, or more than twelve whole digits. The conversion is
 * digit shifting on the string, so no float carries the amount.
 */
export function microsFromDecimal(text: string): string | null {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) return null;
  const [, whole = "", fraction = ""] = match;
  return `${whole}${fraction.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
}
