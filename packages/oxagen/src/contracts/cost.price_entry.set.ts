/**
 * `set_price_entry`: write one organization's negotiated rate into the price
 * book (Mission Control spec §12.2; ADR-060 §1). A negotiated row carries the
 * organization's own `orgId` and wins over the list row for the same model and
 * token class, so from `effectiveFrom` on, every frame that resolves to this
 * model and class is priced at the contracted rate instead of the provider's
 * published one.
 *
 * `additionalRates` writes other token classes for this model in the same
 * transaction and at the same instant. Every class commits or none does.
 * Existing callers that omit it keep the one-class input and output shape.
 *
 * Prices arrive as USD per one million units — a person types `2.40`, the way
 * the contract reads — and are recorded as integer micro-USD per million by
 * `usdPerMillionToMicros`. The book is read back in micros
 * (`list_price_entries`), because JSON has no integer wide enough to promise.
 *
 * This changes what every run in the organization is billed at, so it is not a
 * Member's to make: `sensitivity: "high"`, `defaultEffect: "deny"`, and only
 * the org Owner, Admin and Billing roles. The handler asserts the same roles
 * itself — the kernel's IAM check allows every capability for a
 * non-enterprise organization (INV-29), so `defaultRoles` alone decides
 * nothing below enterprise.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  priceEntrySchema,
  priceTokenClassSchema,
} from "./cost.price_entry.list";

/**
 * USD per one million units, as a person reads it off a contract: `2.40` is
 * $2.40 per 1M tokens. Recorded to the nearest micro-USD. The ceiling is a
 * typo guard on a figure typed by hand, not a commercial limit — no published
 * model rate is within four orders of magnitude of it.
 */
export const usdPerMillionSchema = z.number().finite().min(0).max(1_000_000);

/** Which row the write addresses; `region` null is the region-agnostic row. */
const priceEntryKeyShape = {
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  tokenClass: priceTokenClassSchema,
  region: z.string().min(1).max(64).nullable().optional(),
};

export const costPriceEntrySet = registerCapability({
  name: "set_price_entry",
  domain: "cost",
  description:
    "Set this organization's negotiated rate for one model and token class, in USD per one million units, effective from an instant. Optional additionalRates commit other classes of the same model in one transaction. The negotiated row wins over the provider list price from then on; the row it supersedes is closed, never overwritten, so a run priced earlier keeps the entry it was priced with. Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  // No "cli" layer: CapabilityLayer has no such member, and check_manifest
  // has no candidate path for one, so declaring it would report a permanent
  // gap. The CLI command is declared on `surfaces` instead, as set_spend_budget
  // does.
  layers: ["schema", "api", "mcp", "app", "unit", "docs"],
  scoped: true,
  // Setting the rate you are billed at must never be refused for being over
  // budget, and it consumes no AI credits.
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z
    .object({
      ...priceEntryKeyShape,
      /** Extra names the frame's model id may arrive under; replaces the stored list. */
      modelAliases: z.array(z.string().min(1).max(256)).max(32).optional(),
      /** The contracted price in USD per one million units. */
      usdPerMillion: usdPerMillionSchema,
      /** Other classes in this card. Duplicate classes are refused before writing. */
      additionalRates: z
        .array(
          z
            .object({
              tokenClass: priceTokenClassSchema,
              usdPerMillion: usdPerMillionSchema,
            })
            .strict(),
        )
        .min(1)
        .max(10)
        .optional(),
      /** RFC 3339; the write instant when omitted. Never earlier than the open row's. */
      effectiveFrom: z.string().datetime().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The row now in effect for the key. */
      entry: priceEntrySchema,
      additionalEntries: z
        .array(
          z
            .object({
              entry: priceEntrySchema,
              closed: priceEntrySchema.nullable(),
            })
            .strict(),
        )
        .optional(),
      /**
       * The row this write closed at `effectiveFrom`, or null when nothing was
       * open for the key or the write corrected a row that had not shipped yet.
       */
      closed: priceEntrySchema.nullable(),
    })
    .strict(),
});

export type CostPriceEntrySetInput = z.output<typeof costPriceEntrySet.input>;
export type CostPriceEntrySetOutput = z.output<typeof costPriceEntrySet.output>;
