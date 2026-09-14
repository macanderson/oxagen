// money.ts — money on the wire.
//
// A contract carries money as integer micro-units in a decimal string with an
// ISO 4217 currency (apps/app/ARCHITECTURE.md INV-09). A float never crosses
// the wire: `Number(micros) / 1e6` loses cents above 2^53 micros and rounds
// sub-cent rates, and a client cannot tell a rounded figure from an exact one.
// A metered figure adds `basis`, the observer that produced it, so a number
// never reads stronger than its source (INV-10).
import { z } from "zod";

/** Integer micro-units as a decimal string, never a float. */
export const microsSchema = z.string().regex(/^-?\d+$/, "integer micros");

/** ISO 4217, three letters. */
export const currencySchema = z.string().length(3);

export const moneySchema = z
  .object({
    micros: microsSchema,
    currency: currencySchema,
  })
  .strict();

export type Money = z.output<typeof moneySchema>;

/** Who observed a metered figure. */
export const costBasisSchema = z.enum(["gateway_observed", "client_attested"]);

export const costSchema = moneySchema
  .extend({ basis: costBasisSchema })
  .strict();

export type Cost = z.output<typeof costSchema>;

/** A bigint or integer number of micros as the wire string. */
export function microsString(micros: bigint | number): string {
  if (typeof micros === "number" && !Number.isSafeInteger(micros)) {
    throw new RangeError(`micros must be a safe integer: ${String(micros)}`);
  }
  return String(micros);
}

/** The wire string back to a bigint. The schema has already refused a non-integer. */
export function parseMicros(micros: string): bigint {
  return BigInt(micros);
}
