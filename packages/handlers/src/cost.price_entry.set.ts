// `set_price_entry` (ADR-060 §1): write this organization's negotiated rate
// for one model and token class into `cost.price_entries`.
//
// This is a privileged commercial mutation — it changes what every run in the
// organization is billed at — so it is NOT audit-exempt. `billing.plan_changed`
// is the taxonomy's "this organization's commercial terms moved" event, the
// same one `set_org_billing_terms` emits; no price-book-specific type exists
// and inventing one here is exactly what the audit-coverage guard forbids.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, because the kernel's IAM check allows every capability for a
// non-enterprise organization (INV-29, apps/app/ARCHITECTURE.md §3.2). An
// API-key call acts as the key's creator, bounded by that user's current org
// role.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntrySet,
  type CostPriceEntrySetOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.set";
import {
  setNegotiatedPriceEntry,
  usdPerMillionToMicros,
  type NegotiatedPriceWrite,
  type SetNegotiatedPriceEntryArgs,
} from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";
import { toPriceEntryDto } from "./lib/price-entry-dto";

export type PriceEntrySetDeps = {
  setNegotiatedPriceEntry: (
    args: SetNegotiatedPriceEntryArgs,
  ) => Promise<NegotiatedPriceWrite>;
  now: () => Date;
};

export function createPriceEntrySetHandler(
  deps: PriceEntrySetDeps,
): CapabilityHandler<typeof costPriceEntrySet> {
  return async (input, ctx): Promise<CostPriceEntrySetOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing"] },
    );

    const effectiveFrom =
      input.effectiveFrom === undefined
        ? deps.now()
        : new Date(input.effectiveFrom);

    // The customer states the contracted price the way the contract reads it
    // — USD per one million units — and the store records integer micro-USD.
    const written = await deps.setNegotiatedPriceEntry({
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: input.region ?? null,
      modelAliases: input.modelAliases ?? [],
      microsPerMillion: usdPerMillionToMicros(input.usdPerMillion),
      effectiveFrom,
    });

    // ── Audit (SOC 2 CC6.3) ───────────────────────────────────────────────
    // Fire-and-forget, like every other kernel-path emit: an audit row that
    // cannot be written must not fail a write that already committed. The
    // structured log carries the previous price so an auditor can reconstruct
    // the change; the security_events row is the tamper-evident marker.
    emitSecurityEvent({
      eventType: "billing.plan_changed",
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: costPriceEntrySet.name,
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
        previousMicrosPerMillion:
          written.closed === null
            ? null
            : written.closed.microsPerMillion.toString(),
        microsPerMillion: written.entry.microsPerMillion.toString(),
        effectiveFrom: written.entry.effectiveFrom.toISOString(),
        surface: ctx.surface,
      },
      "cost.price_entry.set: negotiated price written",
    );

    return {
      entry: toPriceEntryDto(written.entry),
      closed: written.closed === null ? null : toPriceEntryDto(written.closed),
    };
  };
}

export const priceEntrySetHandler = createPriceEntrySetHandler({
  setNegotiatedPriceEntry,
  now: () => new Date(),
});
