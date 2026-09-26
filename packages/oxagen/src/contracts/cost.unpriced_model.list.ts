/**
 * `list_unpriced_models`: the models this organization is running that the
 * price book cannot price (Mission Control spec §12.2; ADR-060 §1).
 *
 * A frame whose model nothing prices is recorded `unpriced` by the rollup —
 * no cost, no basis, never a zero — so the run comes back with a blank cost
 * and no explanation. This is the explanation: which model, how much of it
 * has been run, and which token classes are missing a price. The answer is a
 * `negotiated` row from `set_price_entry` for a rate the organization holds
 * itself, or an operator rate stated for the whole installation.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { priceTokenClassSchema } from "./cost.price_entry.list";

/** The window the read covers when the caller names no `since`. */
export const UNPRICED_MODEL_WINDOW_DAYS = 30;

/**
 * One token class this model ran that the book could not price, and the span
 * of the calls it went unpriced over — the window the Pricing tab explains a
 * blank run's cost with, rather than only naming the class.
 */
export const missingClassWindowSchema = z
  .object({
    tokenClass: priceTokenClassSchema,
    unpricedFrom: z.string().datetime(),
    unpricedTo: z.string().datetime(),
    /** Calls in the unpriced buckets of this class. */
    calls: z.number().int().nonnegative(),
    /** Tokens in the unpriced buckets, or requests for server_tool_request. */
    units: z.number().int().nonnegative(),
  })
  .strict();

export const unpricedModelSchema = z
  .object({
    model: z.string(),
    /** Null when the frames name no vendor. */
    provider: z.string().nullable(),
    /** Model calls seen in the window. */
    calls: z.number().int().nonnegative(),
    /** Total tokens across every class, the ranking the list is ordered by. */
    tokens: z.number().int().nonnegative(),
    firstSeen: z.string().datetime(),
    lastSeen: z.string().datetime(),
    /**
     * The token classes this model actually used that have no effective
     * price entry covering the calls that used them. A class the model never
     * sent a token in is never named here, even when the book has no row
     * for it at all.
     */
    missingClasses: z.array(priceTokenClassSchema),
    /** The same classes, each with the window its unpriced calls fall in. */
    missingClassWindows: z.array(missingClassWindowSchema),
    /** True when every class the model used is missing — the run has no cost at all. */
    fullyUnpriced: z.boolean(),
  })
  .strict();

export const costUnpricedModelList = registerCapability({
  name: "list_unpriced_models",
  domain: "cost",
  description:
    "List the models this organization has run that the price book cannot price: the model, its vendor, how many calls and tokens it has run in the window, and which token classes are missing a price — the reason a run's cost comes back blank.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** RFC 3339; the last 30 days when omitted. */
      since: z.string().datetime().optional(),
      /** RFC 3339; the instant the book must be effective at, the read instant when omitted. */
      at: z.string().datetime().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The start of the window the models were observed over. */
      since: z.string().datetime(),
      /** The instant the book was resolved at. */
      at: z.string().datetime(),
      /** Fully unpriced models first, then by tokens run, then by model id. */
      models: z.array(unpricedModelSchema),
    })
    .strict(),
});

export type CostUnpricedModelListInput = z.output<
  typeof costUnpricedModelList.input
>;
export type CostUnpricedModelListOutput = z.output<
  typeof costUnpricedModelList.output
>;
export type UnpricedModelDto = z.output<typeof unpricedModelSchema>;
export type MissingClassWindowDto = z.output<typeof missingClassWindowSchema>;
