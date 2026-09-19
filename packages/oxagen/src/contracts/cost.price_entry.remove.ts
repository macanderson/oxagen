/**
 * `remove_price_entry`: end this organization's negotiated rate for one model
 * and token class (Mission Control spec §12.2; ADR-060 §1). From `at` on, the
 * frame resolves to the provider list price again.
 *
 * It removes the row from the *active* book, not from the book: the row is
 * closed — `effective_to = at` — and kept, because a cost record priced before
 * `at` names the entry id it was priced with and must still be able to read
 * it. Nothing here deletes history, and nothing here touches a list row: the
 * platform's published price is not an organization's to change, and a key
 * this organization never negotiated answers `closed: null`, which claims
 * nothing was removed.
 *
 * One token class per call, for the same reason `set_price_entry` takes one:
 * a token class is a row, each effective-dated on its own, and closing them
 * one at a time is the only way each close is atomic. Ending a whole card is
 * a loop with one `at`.
 *
 * The fallback is checked before the row is closed. "Falls back to the list
 * price" is only true when a list price exists: for a custom model, or a
 * class no catalog publishes, nothing underneath the negotiated row prices
 * the frame, and closing it makes the model unpriced — an unpriced frame
 * yields a null cost, so runs stop carrying a cost at all rather than
 * carrying a cheaper one. A removal with no fallback underneath is therefore
 * refused (`conflict` / `price_entry_no_fallback`) unless the caller sets
 * `acknowledgeUnpriced`, which says the model going unpriced is the intent.
 * Nothing about it is silent either way.
 *
 * Re-ending a class this organization has already ended is a no-op that
 * answers `closed: null`, so a retry is safe. So is a retry after a
 * cancellation: a scheduled row that never began is deleted, and the retry
 * finds nothing and answers the same null close.
 *
 * This changes what every run in the organization is billed at, so it is not a
 * Member's to make: `sensitivity: "high"`, `defaultEffect: "deny"`, and only
 * the org Owner, Admin and Billing roles. The handler asserts the same roles
 * itself — the kernel's IAM check allows every capability for a
 * non-enterprise organization (INV-29).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  priceEntrySchema,
  priceTokenClassSchema,
} from "./cost.price_entry.list";

export const costPriceEntryRemove = registerCapability({
  name: "remove_price_entry",
  domain: "cost",
  description:
    "End this organization's negotiated rate for one model and token class at an instant, so every frame from then on is priced at the provider list price again. The row is closed, not deleted: a run priced before the instant still names the entry it was priced with. Refused when no list price or override can price that model and class, because the frame would become unpriced rather than cheaper; pass acknowledgeUnpriced to end it anyway. Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  // No "cli" layer: CapabilityLayer has no such member, and check_manifest
  // has no candidate path for one, so declaring it would report a permanent
  // gap. The CLI command is declared on `surfaces` instead, as set_spend_budget
  // does.
  layers: ["schema", "api", "mcp", "app", "unit", "docs"],
  scoped: true,
  // Returning to list pricing must never be refused for being over budget, and
  // it consumes no AI credits.
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
      provider: z.string().min(1).max(128),
      model: z.string().min(1).max(256),
      tokenClass: priceTokenClassSchema,
      /** Null (the default) is the region-agnostic row. */
      region: z.string().min(1).max(64).nullable().optional(),
      /** RFC 3339; the write instant when omitted. Must be after the row starts. */
      at: z.string().datetime().optional(),
      /**
       * End the rate even though nothing underneath prices this model and
       * class, so every frame from `at` on is unpriced and its runs record no
       * cost. False (the default) refuses that removal rather than performing
       * it quietly.
       */
      acknowledgeUnpriced: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The instant the negotiated rate stopped applying. */
      at: z.string().datetime(),
      /** The row as closed, or null when the organization had already ended it. */
      closed: priceEntrySchema.nullable(),
      /**
       * The list row or override the model and class now resolve to, or null
       * when nothing underneath prices them and the caller acknowledged that
       * the frames become unpriced. Null with a null `closed` claims nothing:
       * there was no negotiated rate to end.
       */
      fallback: priceEntrySchema.nullable(),
    })
    .strict(),
});

export type CostPriceEntryRemoveInput = z.output<
  typeof costPriceEntryRemove.input
>;
export type CostPriceEntryRemoveOutput = z.output<
  typeof costPriceEntryRemove.output
>;
