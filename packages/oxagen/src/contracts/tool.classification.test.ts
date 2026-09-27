import { describe, expect, it } from "vitest";
import {
  IMPACT_STARTER_SET,
  toolClassificationSchema,
} from "./tool.classification";

const base = {
  sideEffect: "irreversible",
  egress: "third_party",
  impacts: ["moves_money"],
  measures: {
    amount: { path: "$.amount", type: "money", currencyPath: "$.currency" },
    counterparty: { path: "$.recipient", type: "identifier" },
  },
  dataClasses: ["payments"],
};

describe("tool classification schema (spec §6.9 part 1)", () => {
  it("accepts the spec's example classification", () => {
    expect(toolClassificationSchema.parse(base)).toEqual(base);
  });

  it("accepts every starter-set tag and a customer tag", () => {
    const parsed = toolClassificationSchema.parse({
      ...base,
      impacts: [...IMPACT_STARTER_SET, "touches_phi"],
    });
    expect(parsed.impacts).toHaveLength(7);
  });

  it("refuses a tag outside snake_case", () => {
    expect(
      toolClassificationSchema.safeParse({
        ...base,
        impacts: ["Moves Money"],
      }).success,
    ).toBe(false);
  });

  it("refuses a repeated tag", () => {
    expect(
      toolClassificationSchema.safeParse({
        ...base,
        impacts: ["moves_money", "moves_money"],
      }).success,
    ).toBe(false);
  });

  it("requires a currency path on a money measure", () => {
    const result = toolClassificationSchema.safeParse({
      ...base,
      measures: { amount: { path: "$.amount", type: "money" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "measures",
        "amount",
        "currencyPath",
      ]);
    }
  });

  it("refuses a measure path that does not start at the input root", () => {
    expect(
      toolClassificationSchema.safeParse({
        ...base,
        measures: { rows: { path: "rows", type: "count", unit: "rows" } },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown key", () => {
    expect(
      toolClassificationSchema.safeParse({ ...base, risk: "high" }).success,
    ).toBe(false);
  });
});
