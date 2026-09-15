// audit-exempt: read-only — lists the price book the organization is priced against; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_price_entries` (ADR-060 §1): the list catalog and the organization's
// own negotiated rows, effective at `at`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntryList,
  type CostPriceEntryListOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { listPriceEntries, type PriceEntry } from "@oxagen/billing";

export type PriceEntryListDeps = {
  listPriceEntries: (args: {
    at: Date;
    orgId: string;
  }) => Promise<PriceEntry[]>;
  now: () => Date;
};

export function createPriceEntryListHandler(
  deps: PriceEntryListDeps,
): CapabilityHandler<typeof costPriceEntryList> {
  return async (input, ctx): Promise<CostPriceEntryListOutput> => {
    const at = input.at === undefined ? deps.now() : new Date(input.at);
    const entries = await deps.listPriceEntries({ at, orgId: ctx.orgId });
    return {
      at: at.toISOString(),
      entries: entries.map((e) => ({
        id: e.id,
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
