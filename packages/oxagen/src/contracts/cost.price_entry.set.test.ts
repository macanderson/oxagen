import { describe, expect, it } from "vitest";
import { costPriceEntrySet } from "./cost.price_entry.set";

const input = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  tokenClass: "input_uncached",
  usdPerMillion: 2.4,
};

describe("set_price_entry contract", () => {
  it("changes what every run in the org is billed at, so it is a high-sensitivity write", () => {
    expect(costPriceEntrySet.mutates).toBe(true);
    expect(costPriceEntrySet.sensitivity).toBe("high");
    expect(costPriceEntrySet.defaultEffect).toBe("deny");
    expect(costPriceEntrySet.noBillingGate).toBe(true);
    // Not a Member's to set: a negotiated rate is the commercial term the
    // whole organization is metered against.
    expect(
      Object.keys(costPriceEntrySet.defaultRoles?.org ?? {}),
    ).not.toContain("Member");
    expect(costPriceEntrySet.defaultRoles?.org?.Owner).toBe("allow");
  });

  it("takes a price a human types — USD per million, not micros", () => {
    expect(costPriceEntrySet.input.parse(input)).toMatchObject({
      usdPerMillion: 2.4,
    });
    expect(
      costPriceEntrySet.input.safeParse({ ...input, usdPerMillion: -1 })
        .success,
    ).toBe(false);
    // Free is a price someone can legitimately have negotiated.
    expect(
      costPriceEntrySet.input.safeParse({ ...input, usdPerMillion: 0 }).success,
    ).toBe(true);
  });

  it("prices exactly one token class per call", () => {
    expect(
      costPriceEntrySet.input.safeParse({
        ...input,
        tokenClass: "cache_write_1h",
      }).success,
    ).toBe(true);
    expect(
      costPriceEntrySet.input.safeParse({ ...input, tokenClass: "thinking" })
        .success,
    ).toBe(false);
    // No whole-card shape: a partial write would leave an org priced at a
    // blend of negotiated input and list output that nobody agreed to.
    const { tokenClass: _omitted, ...withoutClass } = input;
    expect(costPriceEntrySet.input.safeParse(withoutClass).success).toBe(false);
  });

  it("answers with the row now in effect and the row it closed", () => {
    expect(Object.keys(costPriceEntrySet.output.shape).sort()).toEqual([
      "closed",
      "entry",
    ]);
  });
});
