/**
 * The vocabulary the spend contracts share (Mission Control spec §12, App. E;
 * ADR-060). Not a capability: this file registers nothing.
 *
 * Money on the wire is integer micro-units as a decimal string with an ISO
 * 4217 currency, and a metered figure carries the basis that says who
 * observed it (INV-09, INV-10): the gateway, the harness, both (`mixed`), or
 * nobody with a price for the model (`estimated`). A figure no frame priced
 * is null on the contract, never a zero.
 */
import { z } from "zod";

export const costBasisSchema = z.enum([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);
export type CostBasis = z.output<typeof costBasisSchema>;

/** Integer micro-units as a decimal string, never a float. */
export const microsSchema = z.string().regex(/^-?\d+$/, "integer micros");

export const moneySchema = z
  .object({
    micros: microsSchema,
    /** ISO 4217. */
    currency: z.string().length(3),
  })
  .strict();

/** A metered cost: money plus who observed it. */
export const costSchema = moneySchema
  .extend({ basis: costBasisSchema })
  .strict();
export type Cost = z.output<typeof costSchema>;

/** `YYYY-MM-DD`, a UTC calendar day. */
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD day")
  .refine(
    (d) => {
      const at = new Date(`${d}T00:00:00.000Z`);
      // A round trip catches a day the month does not have (2026-02-30).
      return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(d);
    },
    { message: "a real calendar day" },
  );

/** `YYYY-MM`, a UTC calendar month. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a YYYY-MM month");

/** Inclusive day range; `to` on or after `from`. */
export const dayRangeSchema = z
  .object({ from: daySchema, to: daySchema })
  .strict()
  .refine((r) => r.from <= r.to, {
    message: "to must be on or after from",
    path: ["to"],
  });

/** The token classes every model call is normalized to (spec §12.6). */
export const tokenCountsSchema = z
  .object({
    input_uncached: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative(),
    cache_write_5m: z.number().int().nonnegative(),
    cache_write_1h: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
  })
  .strict();
export type TokenCounts = z.output<typeof tokenCountsSchema>;

/** The levels spend is attributed to (spec §12.7). */
export const spendGroupKindSchema = z.enum([
  "operator",
  "agent",
  "model",
  "tool",
  "task",
]);
export type SpendGroupKind = z.output<typeof spendGroupKindSchema>;

/** A 0..1 ratio; null when nothing measured it. */
export const ratioSchema = z.number().min(0).max(1);

/**
 * One rollup figure at any level: what it cost, how much of that is proven or
 * accepted (null until a verdict lane writes one), and how productive the
 * runs were (null until the grading lane writes it).
 */
export const spendFigureSchema = z
  .object({
    /** Null when no frame in the group was priced. */
    cost: costSchema.nullable(),
    calls: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    proven: moneySchema.nullable(),
    accepted: moneySchema.nullable(),
    productiveRatio: ratioSchema.nullable(),
  })
  .strict();
export type SpendFigure = z.output<typeof spendFigureSchema>;
