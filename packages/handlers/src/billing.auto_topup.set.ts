// billing.auto_topup.set.ts — handler for the set_auto_topup capability.
//
// The customer half of the two billing-terms writes (ADR-055 §5,
// apps/app/ARCHITECTURE.md §3.9 item 12): whether the recorder charges the
// saved card when the GAU bucket runs out, and for how many blocks.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin. The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler owns
//      this check (§3.2, INV-29). A Member or a Billing user is refused.
//   2. Upsert the two columns on org_billing_settings, keyed on org_id, and
//      return them as stored. The org may have no settings row yet; the
//      upsert creates it.
//   3. Audit the mutation.
//
// The write is accepted in either billing mode and with or without a saved
// card: the columns exist on every org and the recorder reads them only in
// prepaid, once a card is on file. That is what makes the column defaults
// (enabled, one block) the Free-tier rule of 2026-09-14 — a Free org that
// saves a card auto tops up one 5,000-GAU block at the list rate without ever
// invoking this capability.
//
// The kernel enters the tenant scope before the handler runs, so the upsert
// goes through withTenantDb and RLS is the tenant fence.

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  billingAutoTopupSet,
  type BillingAutoTopupSetOutput,
} from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import { setAutoTopup, type AutoTopupSettings } from "@oxagen/billing";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

/** The one write the handler makes. Runs inside the kernel's tenant scope. */
export type AutoTopupWriter = (
  orgId: string,
  input: AutoTopupSettings,
) => Promise<AutoTopupSettings>;

export function createBillingAutoTopupSetHandler(
  write: AutoTopupWriter,
): CapabilityHandler<typeof billingAutoTopupSet> {
  return async (input, ctx): Promise<BillingAutoTopupSetOutput> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(ctx, { org: ["Owner", "Admin"] });

    // ── Write ─────────────────────────────────────────────────────────────
    const stored = await write(ctx.orgId, {
      enabled: input.enabled,
      blocks: input.blocks,
    });

    // ── Audit ─────────────────────────────────────────────────────────────
    // SOC 2 CC6.3: changing whether the platform may charge a saved card
    // without a person present is a privileged state change. The taxonomy's
    // `billing.auto_reload_updated` is the "when to top up" event; auto
    // top-up is that decision for governed action units rather than credits.
    emitSecurityEvent({
      eventType: "billing.auto_reload_updated",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: billingAutoTopupSet.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        enabled: stored.enabled,
        blocks: stored.blocks,
        surface: ctx.surface,
      },
      "billing.auto_topup.set: auto top-up updated",
    );

    return stored;
  };
}

export const billingAutoTopupSetHandler =
  createBillingAutoTopupSetHandler(setAutoTopup);
