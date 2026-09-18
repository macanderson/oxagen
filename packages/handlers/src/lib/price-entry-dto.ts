/**
 * One price-book row on the wire, shared by the two write handlers
 * (`set_price_entry`, `remove_price_entry`).
 *
 * `microsPerMillion` leaves as a decimal string: the store holds it as a
 * bigint and JSON has no integer wide enough to promise, so the figure every
 * run in the organization is billed against never becomes a float.
 */
import type { PriceEntry } from "@oxagen/billing";
import type { PriceEntryDto } from "@oxagen/oxagen/contracts/cost.price_entry.list";

export function toPriceEntryDto(entry: PriceEntry): PriceEntryDto {
  return {
    id: entry.id,
    orgId: entry.orgId,
    provider: entry.provider,
    model: entry.model,
    modelAliases: [...entry.modelAliases],
    region: entry.region,
    tokenClass: entry.tokenClass,
    unit: entry.unit,
    currency: entry.currency,
    microsPerMillion: entry.microsPerMillion.toString(),
    effectiveFrom: entry.effectiveFrom.toISOString(),
    effectiveTo: entry.effectiveTo?.toISOString() ?? null,
    source: entry.source,
  };
}
