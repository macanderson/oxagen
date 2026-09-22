/**
 * `scheduledEntryId` cancels only one future row, restores its predecessor,
 * and retains later scheduled rows. An already-started row is refused.
 *
 * `remove_price_entry`: end this organization's negotiated rate for one model
 * and token class (Mission Control spec §12.2; ADR-060 §1). From `at` on, the
 * frame resolves to the provider list price again — when one exists.
 * `fallbackPriced` in the output says whether it does: a model this
 * organization negotiated alone, with no list or override row of its own, has
 * nothing to fall back to, and the class goes unpriced rather than
 * list-priced. The caller must read this before repeating the usual
 * "falls back to the list price" line.
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
 *
 * `confirmUnpriced` gates the one outcome the contract, the CLI and the
 * dialog all promise will not happen: a class that "falls back to the list
 * price" instead going unpriced. The handler checks for an effective
 * fallback BEFORE it closes anything, and when none exists it refuses with
 * `price_entry_close_would_unprice` rather than close and hope the caller
 * reads `fallbackPriced` in the output afterward — closing is a soft delete
 * (see above), but the window between "closed" and "someone notices and sets
 * a new rate" still prices every frame in it wrong. `confirmUnpriced: true`
 * is the caller stating it read that refusal and wants to proceed anyway.
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
    "End this organization's negotiated rate for one model and token class at an instant, so every frame from then on is priced at the provider list price again. The row is closed, not deleted: a run priced before the instant still names the entry it was priced with. Owner / Admin / Billing only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "app", "unit", "docs"],
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
      /** Cancel only this future row, restoring its predecessor and keeping later rates. Cannot be combined with at. */
      scheduledEntryId: z.string().uuid().optional(),
      /** Opaque app alternative to scheduledEntryId, issued by the management read. */
      cancellationToken: z.string().max(4096).optional(),
      /**
       * Required (true) when closing this row would leave the class with no
       * list, override or other negotiated fallback — the handler checks
       * before closing and refuses with `price_entry_close_would_unprice`
       * otherwise. Ignored, not required, when a fallback exists.
       */
      confirmUnpriced: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The instant the negotiated rate stopped applying. */
      at: z.string().datetime(),
      /** The row as closed, or null when the organization had already ended it. */
      closed: priceEntrySchema.nullable(),
      /**
       * Whether a list, override or other negotiated row still prices this
       * model and class from `at` on. False means the class has no fallback
       * and is now unpriced, not list-priced — the caller must say so rather
       * than repeat the usual "falls back to the list price" line. Always
       * resolved again when `closed` is null, including cancellation retries.
       */
      fallbackPriced: z.boolean(),
    })
    .strict(),
});

export type CostPriceEntryRemoveInput = z.output<
  typeof costPriceEntryRemove.input
>;
export type CostPriceEntryRemoveOutput = z.output<
  typeof costPriceEntryRemove.output
>;
