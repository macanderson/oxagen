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
