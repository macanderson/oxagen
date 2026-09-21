/**
 * `list_price_entries`: the price book as the active organization reads it
 * (Mission Control spec §12.2; ADR-060 §1): every list price effective at
 * `at` and the organization's own negotiated rows, which win over the list
 * row for the same model and class. Prices are integer micro-USD per one
 * million units; a cost record names the entry ids it was priced with.
 * `includeScheduled` opts management views into future negotiated rows for
 * this organization. Other callers retain the effective-at-instant read.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { microsSchema } from "./spend.shared";

export const priceTokenClassSchema = z.enum([
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
]);

export const priceEntrySchema = z
  .object({
    id: z.string().uuid(),
    /** Opaque app token for cancelling this future negotiated row. */
    cancellationToken: z.string().optional(),
    /** Null for a list price every organization reads. */
    orgId: z.string().uuid().nullable(),
    provider: z.string(),
    model: z.string(),
    modelAliases: z.array(z.string()),
    region: z.string().nullable(),
    tokenClass: priceTokenClassSchema,
    unit: z.enum(["token", "request", "image", "second"]),
    currency: z.string().length(3),
    /** Integer micro-units per one million units. */
    microsPerMillion: microsSchema,
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().nullable(),
    source: z.enum(["list", "negotiated", "override"]),
  })
  .strict();

export const costPriceEntryList = registerCapability({
  name: "list_price_entries",
  domain: "cost",
  description:
    "List the price book this organization is priced against: every provider list price effective at an instant and the organization's negotiated rows, in integer micros per million units with the window each is effective over.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
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
      /** RFC 3339; the read instant when omitted. */
      at: z.string().datetime().optional(),
      includeScheduled: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      at: z.string().datetime(),
      entries: z.array(priceEntrySchema),
    })
    .strict(),
});

export type CostPriceEntryListInput = z.output<typeof costPriceEntryList.input>;
export type CostPriceEntryListOutput = z.output<
  typeof costPriceEntryList.output
>;
export type PriceEntryDto = z.output<typeof priceEntrySchema>;
