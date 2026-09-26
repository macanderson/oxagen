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
export type Money = z.output<typeof moneySchema>;

/** A metered cost: money plus who observed it. */
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

/** The wire string back to a bigint. `microsSchema` has already refused a non-integer. */
export function parseMicros(micros: string): bigint {
  return BigInt(micros);
}

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

/**
 * The longest window a spend read covers, in days: a quarter. `get_spend` and
 * `list_waste` fold every run row of the range in the handler, and
 * `get_spend_drill`'s trailing window has the same ceiling, so one request
 * reads at most this many days of a workspace's runs.
 */
export const SPEND_RANGE_DAYS_MAX = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days from `from` to `to` inclusive; both `YYYY-MM-DD`. */
function spanDays(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS +
    1
  );
}

/** Inclusive day range; `to` on or after `from`, at most `SPEND_RANGE_DAYS_MAX` days. */
export const dayRangeSchema = z
  .object({ from: daySchema, to: daySchema })
  .strict()
  .refine((r) => r.from <= r.to, {
    message: "to must be on or after from",
    path: ["to"],
  })
  .refine((r) => spanDays(r.from, r.to) <= SPEND_RANGE_DAYS_MAX, {
    message: `at most ${SPEND_RANGE_DAYS_MAX} days`,
    path: ["to"],
  });

/** A principal's public id (`prn_…`, spec §4.3): the key of an `operator` group. */
export const principalPublicIdSchema = z
  .string()
  .regex(/^prn_[0-9a-z]+$/, "a principal public id (prn_…)");

/** The token classes every model call is normalized to (spec §12.6). */
export const tokenCountsSchema = z
  .object({
    input_uncached: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative(),
    cache_write_5m: z.number().int().nonnegative(),
    cache_write_1h: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    /**
     * Provider-side tool requests, such as web searches. A count of requests,
     * not tokens.
     */
    server_tool_request: z.number().int().nonnegative(),
  })
  .strict();
export type TokenCounts = z.output<typeof tokenCountsSchema>;

/**
 * The levels spend is attributed to (spec §12.7), plus the cost center the
 * run is charged back to (ADR-142). A `cost_center` row's key is the label,
 * or {@link UNASSIGNED_COST_CENTER_KEY} for the spend no center claims.
 */
export const spendGroupKindSchema = z.enum([
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
]);
export type SpendGroupKind = z.output<typeof spendGroupKindSchema>;

/**
 * The `cost_center` group key of spend no cost center claims. Mirrors
 * `UNASSIGNED_COST_CENTER_KEY` in `@oxagen/database/schema` (the contracts
 * carry no database dependency); the label pattern refuses `~`, so no label
 * collides with it.
 */
export const UNASSIGNED_COST_CENTER_KEY = "~none";

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

/**
 * Runs in the window that recorded no usage, so no total counts their cost,
 * broken out by the harness that ran them (#3304).
 */
export const unmeteredRunsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    byHarness: z.array(
      z
        .object({
          harness: z.string(),
          runs: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type UnmeteredRuns = z.output<typeof unmeteredRunsSchema>;
