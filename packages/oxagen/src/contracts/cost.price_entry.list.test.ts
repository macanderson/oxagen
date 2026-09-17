import { describe, expect, it } from "vitest";
import { costPriceEntryList, priceEntrySchema } from "./cost.price_entry.list";

const entry = {
  id: "0f2c2a3e-1b6a-4c1d-9c3e-1234567890ab",
  orgId: null,
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelAliases: [],
  region: null,
  tokenClass: "input_uncached",
  unit: "token",
  currency: "USD",
  microsPerMillion: "3000000",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveTo: null,
  source: "list",
};

describe("list_price_entries contract", () => {
  it("is a console read at an optional instant", () => {
    expect(costPriceEntryList.noBillingGate).toBe(true);
    expect(costPriceEntryList.mutates).toBe(false);
    expect(costPriceEntryList.input.parse({})).toEqual({});
    expect(
      costPriceEntryList.input.safeParse({ at: "yesterday" }).success,
    ).toBe(false);
  });

  it("carries a price as integer micros per million with its window and source", () => {
    expect(priceEntrySchema.parse(entry)).toEqual(entry);
    expect(
      priceEntrySchema.safeParse({ ...entry, microsPerMillion: 3000000 })
        .success,
    ).toBe(false);
    expect(
      priceEntrySchema.safeParse({ ...entry, tokenClass: "thinking" }).success,
    ).toBe(false);
    expect(
      priceEntrySchema.safeParse({ ...entry, source: "guess" }).success,
    ).toBe(false);
  });
});
