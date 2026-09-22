import { describe, expect, it } from "vitest";
import { costCenterCreate } from "./cost_center.create";

describe("create_cost_center contract", () => {
  it("takes a label and an optional description", () => {
    expect(costCenterCreate.mutates).toBe(true);
    expect(costCenterCreate.input.parse({ label: "ENG-1001" })).toEqual({
      label: "ENG-1001",
    });
    expect(
      costCenterCreate.input.parse({
        label: "mkt.emea",
        description: " EMEA ",
      }),
    ).toEqual({ label: "mkt.emea", description: "EMEA" });
  });

  it("refuses a label outside the pattern, the unassigned key included", () => {
    for (const label of ["", "~none", "-lead", "has space", "a".repeat(65)]) {
      expect(costCenterCreate.input.safeParse({ label }).success).toBe(false);
    }
    expect(
      costCenterCreate.input.safeParse({ label: "a".repeat(64) }).success,
    ).toBe(true);
  });
});
