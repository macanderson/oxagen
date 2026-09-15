/**
 * `set_auto_topup`: the Auto top-up control on the Billing page
 * (apps/app/ARCHITECTURE.md §1.4, §3.9 item 12, WL-30). The customer half of
 * the two billing-terms writes — the org decides whether the recorder charges
 * the saved card when the bucket runs out, and for how many 5,000-GAU blocks.
 *
 * Accepted in either billing mode: the two columns exist on every org and are
 * read in prepaid, so an invoice-billed org may set them and they stay inert
 * until the mode changes. Accepted for a Free org with or without a saved
 * card — the setting is read only once a card exists (the 2026-09-14 rule,
 * ADR-055 §6): the column defaults (enabled true, one block) already apply to
 * every tier, so a Free org that saves a card auto tops up one block at the
 * list rate without ever coming here.
 *
 * Owner or Admin, checked by the handler with `assertOrgRole` (INV-29): the
 * kernel's IAM check allows every capability for a non-enterprise org, so
 * `defaultRoles` below is what an enterprise resolver reads and the handler is
 * what refuses a Member or a Billing user.
 *
 * Changing a billing setting is never a governed action (§1.5, ADR-052
 * exclusion 2): `noBillingGate: true` keeps it reachable at `remaining = 0`,
 * which is exactly when a customer comes to turn auto top-up on (INV-27).
 *
 * No `app` layer until WL-50 binds the control.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Blocks charged per auto top-up; the column's CHECK is `> 0`. */
const blocksSchema = z.number().int().min(1).max(100);

export const billingAutoTopupSet = registerCapability({
  name: "set_auto_topup",
  domain: "billing",
  description:
    "Turn automatic top-up on or off for the organization and set how many governed-action-unit blocks each top-up buys.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      enabled: z.boolean(),
      blocks: blocksSchema,
    })
    .strict(),
  /** The two fields as stored, read back from the upsert. */
  output: z
    .object({
      enabled: z.boolean(),
      blocks: blocksSchema,
    })
    .strict(),
});

export type BillingAutoTopupSetInput = z.output<
  typeof billingAutoTopupSet.input
>;
export type BillingAutoTopupSetOutput = z.output<
  typeof billingAutoTopupSet.output
>;
