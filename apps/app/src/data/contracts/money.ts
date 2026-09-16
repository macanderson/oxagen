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

/** Six digits of the fraction, finer than any meter draws. */
const RATIO_SCALE = 1_000_000n;

/**
 * `part` as a fraction of `whole`, clamped to 0…1, for a meter's width and
 * the percentage beside it. Both are integer strings — micros for money,
 * whole units for a count — and the division happens on BigInt, so a figure
 * too large for a double still yields the right fraction. A `whole` of zero
 * has no fraction and answers 0.
 */
export function ratioOfIntegers(part: string, whole: string): number {
  const total = toBigInt(whole);
  if (total <= 0n) return 0;
  const drawn = toBigInt(part);
  if (drawn <= 0n) return 0;
  if (drawn >= total) return 1;
  return Number((drawn * RATIO_SCALE) / total) / Number(RATIO_SCALE);
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
