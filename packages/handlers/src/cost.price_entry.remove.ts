// `remove_price_entry` (ADR-060 §1): end this organization's negotiated rate
// for one model and token class, so every frame from that instant on resolves
// to the provider list price again.
//
// The row is closed, never deleted — a cost record priced before the instant
// names the entry id it was priced with — and a list row is refused outright:
// the platform's published price is not an organization's to change.
//
// Privileged commercial mutation, so NOT audit-exempt: `billing.plan_changed`
// is the taxonomy's "this organization's commercial terms moved" event, the
// same one the write side emits.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, because the kernel's IAM check allows every capability for a
// non-enterprise organization (INV-29). An API-key call acts as the key's
// creator.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntryRemove,
  type CostPriceEntryRemoveOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import {
  closeNegotiatedPriceEntry,
  type PriceEntry,
  type PriceTokenClass,
} from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";
import { toPriceEntryDto } from "./lib/price-entry-dto";

export type PriceEntryRemoveDeps = {
  closeNegotiatedPriceEntry: (args: {
    orgId: string;
    provider: string;
    model: string;
    tokenClass: PriceTokenClass;
    region?: string | null;
    at: Date;
  }) => Promise<PriceEntry | null>;
  now: () => Date;
};

export function createPriceEntryRemoveHandler(
  deps: PriceEntryRemoveDeps,
): CapabilityHandler<typeof costPriceEntryRemove> {
  return async (input, ctx): Promise<CostPriceEntryRemoveOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing"] },
    );

    const at = input.at === undefined ? deps.now() : new Date(input.at);
    const closed = await deps.closeNegotiatedPriceEntry({
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: input.region ?? null,
      at,
    });

    // ── Audit (SOC 2 CC6.3) ───────────────────────────────────────────────
    // Emitted whether or not a row was open: the request to return a model to
    // list pricing is the event, and a re-run that finds nothing to close is
    // still somebody asking for the organization's terms to move.
    emitSecurityEvent({
      eventType: "billing.plan_changed",
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: costPriceEntryRemove.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId: actingUserId,
        provider: input.provider,
        model: input.model,
        tokenClass: input.tokenClass,
        region: input.region ?? null,
        at: at.toISOString(),
        closedEntryId: closed?.id ?? null,
        closedMicrosPerMillion: closed?.microsPerMillion.toString() ?? null,
        surface: ctx.surface,
      },
      "cost.price_entry.remove: negotiated price ended",
    );

    return {
      at: at.toISOString(),
      closed: closed === null ? null : toPriceEntryDto(closed),
    };
  };
}

export const priceEntryRemoveHandler = createPriceEntryRemoveHandler({
  closeNegotiatedPriceEntry,
  now: () => new Date(),
});
