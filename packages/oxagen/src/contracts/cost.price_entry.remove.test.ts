import { describe, expect, it } from "vitest";
import { costPriceEntryRemove } from "./cost.price_entry.remove";

const input = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  tokenClass: "input_uncached",
};

describe("remove_price_entry contract", () => {
  it("is the same commercial lever as setting one, so it is gated the same way", () => {
    expect(costPriceEntryRemove.mutates).toBe(true);
    expect(costPriceEntryRemove.sensitivity).toBe("high");
    expect(costPriceEntryRemove.defaultEffect).toBe("deny");
    expect(costPriceEntryRemove.noBillingGate).toBe(true);
    expect(
      Object.keys(costPriceEntryRemove.defaultRoles?.org ?? {}),
    ).not.toContain("Member");
  });

  it("names the row by its key, not by an id", () => {
    expect(costPriceEntryRemove.input.parse(input)).toMatchObject(input);
    expect(
      costPriceEntryRemove.input.safeParse({ ...input, region: null }).success,
    ).toBe(true);
    const { tokenClass: _omitted, ...withoutClass } = input;
    expect(costPriceEntryRemove.input.safeParse(withoutClass).success).toBe(
      false,
    );
    // An entry id would be a raw uuid a person cannot read and cannot type.
    expect(Object.keys(costPriceEntryRemove.input.shape)).not.toContain("id");
  });

  it("ends a window rather than deleting history", () => {
    expect(Object.keys(costPriceEntryRemove.output.shape).sort()).toEqual([
      "at",
      "closed",
    ]);
    expect(costPriceEntryRemove.output.shape.closed.isNullable()).toBe(true);
  });
});
