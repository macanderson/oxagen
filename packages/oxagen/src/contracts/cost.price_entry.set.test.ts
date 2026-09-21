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

  it("requires the primary token class", () => {
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
    // A card still needs its primary class.
    const { tokenClass: _omitted, ...withoutClass } = input;
    expect(costPriceEntrySet.input.safeParse(withoutClass).success).toBe(false);
  });

  it("answers with the row now in effect and the row it closed", () => {
    expect(Object.keys(costPriceEntrySet.output.shape).sort()).toEqual([
      "additionalEntries",
      "closed",
      "entry",
    ]);
  });
});

it("accepts bounded additional classes and refuses invalid prices", () => {
  expect(
    costPriceEntrySet.input.parse({
      ...input,
      additionalRates: [{ tokenClass: "output", usdPerMillion: 15 }],
    }).additionalRates,
  ).toHaveLength(1);
  for (const additionalRates of [
    [],
    [{ tokenClass: "output", usdPerMillion: -1 }],
    Array.from({ length: 11 }, () => ({
      tokenClass: "output",
      usdPerMillion: 15,
    })),
  ]) {
    expect(
      costPriceEntrySet.input.safeParse({ ...input, additionalRates }).success,
    ).toBe(false);
  }
});
