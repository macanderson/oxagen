// audit-exempt: read-only — lists the price book the organization is priced against; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_price_entries` (ADR-060 §1): the list catalog and the organization's
// own negotiated rows, effective at `at`.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, for the same reason `cost.unpriced_model.list.ts` gates:
// the kernel's IAM check allows every capability for a non-enterprise
// organization (INV-29, apps/app/ARCHITECTURE.md §3.2), so the contract
// naming only Owner, Admin, Billing and Member is decorative unless the
// handler asserts it. This read names negotiated rates, which is the same
// commercial detail `set_price_entry` and `remove_price_entry` already gate.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntryList,
  type CostPriceEntryListOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { listPriceEntries, type PriceEntry } from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";

import { sealPriceCancellation } from "./lib/price-cancellation-token";

export type PriceEntryListDeps = {
  listPriceEntries: (args: {
    at: Date;
    orgId: string;
    includeScheduled?: boolean;
  }) => Promise<PriceEntry[]>;
  now: () => Date;
};

export function createPriceEntryListHandler(
  deps: PriceEntryListDeps,
): CapabilityHandler<typeof costPriceEntryList> {
  return async (input, ctx): Promise<CostPriceEntryListOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing", "Member"] },
    );

    const at = input.at === undefined ? deps.now() : new Date(input.at);
    const entries = await deps.listPriceEntries({
      at,
      orgId: ctx.orgId,
      ...(input.includeScheduled === undefined
        ? {}
        : { includeScheduled: input.includeScheduled }),
    });
    return {
      at: at.toISOString(),
      entries: entries.map((e) => ({
        id: e.id,
        ...(ctx.surface === "app" &&
        input.includeScheduled === true &&
        e.orgId === ctx.orgId &&
        e.source === "negotiated" &&
        e.effectiveFrom > at
          ? {
              cancellationToken: sealPriceCancellation({
                id: e.id,
                orgId: e.orgId,
                provider: e.provider,
                model: e.model,
                tokenClass: e.tokenClass,
                region: e.region,
                source: "negotiated",
                effectiveFrom: e.effectiveFrom.toISOString(),
              }),
            }
          : {}),
        orgId: e.orgId,
        provider: e.provider,
        model: e.model,
        modelAliases: [...e.modelAliases],
        region: e.region,
        tokenClass: e.tokenClass,
        unit: e.unit,
        currency: e.currency,
        microsPerMillion: e.microsPerMillion.toString(),
        effectiveFrom: e.effectiveFrom.toISOString(),
        effectiveTo: e.effectiveTo?.toISOString() ?? null,
        source: e.source,
      })),
    };
  };
}

export const priceEntryListHandler = createPriceEntryListHandler({
  listPriceEntries,
  now: () => new Date(),
});
