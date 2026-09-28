import { describe, expect, it } from "vitest";
import { spendOperatorPseudonymsSet } from "./spend.operator_pseudonyms.set";

describe("set_operator_pseudonyms contract", () => {
  it("is an org Owner or Admin write of one flag", () => {
    expect(spendOperatorPseudonymsSet.mutates).toBe(true);
    expect(spendOperatorPseudonymsSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(
      spendOperatorPseudonymsSet.input.parse({ enabled: true }),
    ).toEqual({ enabled: true });
    expect(
      spendOperatorPseudonymsSet.input.safeParse({ enabled: "yes" }).success,
    ).toBe(false);
    expect(
      spendOperatorPseudonymsSet.output.parse({ pseudonyms: false }),
    ).toEqual({ pseudonyms: false });
  });
});
