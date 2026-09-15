// Money on the wire (ARCHITECTURE.md §3.9, INV-09): integer micro-units as a
// decimal string with an ISO 4217 currency, and a metered cost that says who
// observed it. This module is the one place
// arithmetic on micros happens, with BigInt, so no figure passes through a
// float. Formatting is src/ui/money-format.ts.
import { z } from "zod";

const MICROS = /^-?\d+$/;

export const Money = z.object({
  micros: z.string().regex(MICROS),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof Money>;

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
