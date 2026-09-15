import { describe, expect, it } from "vitest";
import { Currency, Money, OrgRole } from "./common";

describe("Money", () => {
  it("accepts integer micros as a decimal string, with or without a basis", () => {
    expect(Money.parse({ micros: "2450000000", currency: "USD" })).toEqual({
      micros: "2450000000",
      currency: "USD",
    });
    expect(
      Money.parse({ micros: "-15", currency: "EUR", basis: "estimated" }).basis,
    ).toBe("estimated");
  });

  it.each([
    ["a display string", "2,450.00"],
    ["a decimal", "2450.5"],
    ["an empty string", ""],
  ])("rejects %s", (_label, micros) => {
    expect(Money.safeParse({ micros, currency: "USD" }).success).toBe(false);
  });

  it("rejects a float number, which would lose precision", () => {
    expect(Money.safeParse({ micros: 2450.5, currency: "USD" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown basis and a malformed currency", () => {
    expect(
      Money.safeParse({ micros: "1", currency: "USD", basis: "guessed" })
        .success,
    ).toBe(false);
    expect(Currency.safeParse("US").success).toBe(false);
  });
});

describe("OrgRole", () => {
  it("accepts the six stored roles and nothing else", () => {
    expect(OrgRole.options).toHaveLength(6);
    expect(OrgRole.safeParse("Owner").success).toBe(false);
    expect(OrgRole.safeParse("superuser").success).toBe(false);
  });
});
