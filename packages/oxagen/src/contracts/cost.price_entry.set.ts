/**
 * `set_price_entry`: write one organization's negotiated rate into the price
 * book (Mission Control spec §12.2; ADR-060 §1). A negotiated row carries the
 * organization's own `orgId` and wins over the list row for the same model and
 * token class, so from `effectiveFrom` on, every frame that resolves to this
 * model and class is priced at the contracted rate instead of the provider's
 * published one.
 *
 * ── Why the call is one token class, not a whole rate card ──────────────────
 *
 * A negotiated contract usually names several classes at once, so a whole-card
 * input is the shape a human has in front of them. It is not the shape the
 * store can honour: `cost.price_entries` records one row per (provider, model,
 * token class, region, effective_from), each effective-dated on its own, and
 * the writer upserts one row per statement. A four-class card would therefore
 * be four statements, and a failure after the second would leave the
 * organization priced at a blend — negotiated input, list output — that nobody
 * agreed to and that nothing in the book would flag. One class per call keeps
 * the capability atomic on exactly the row the resolver later picks, and a
 * whole card is a loop the caller (`oxagen price set`, a script, an operator)
 * runs with one `effectiveFrom` for every class.
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
    "Set this organization's negotiated rate for one model and token class, in USD per one million units, effective from an instant. The negotiated row wins over the provider list price from then on; the row it supersedes is closed, never overwritten, so a run priced earlier keeps the entry it was priced with. Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  // No "cli" layer: CapabilityLayer has no such member, and check_manifest
  // has no candidate path for one, so declaring it would report a permanent
  // gap. The CLI command is declared on `surfaces` instead, as set_spend_budget
  // does.
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      /** RFC 3339; the write instant when omitted. Never earlier than the open row's. */
      effectiveFrom: z.string().datetime().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The row now in effect for the key. */
      entry: priceEntrySchema,
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
