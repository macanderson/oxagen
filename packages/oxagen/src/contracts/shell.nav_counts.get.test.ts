import { describe, expect, it } from "vitest";
import { shellNavCountsGet } from "./shell.nav_counts.get";

describe("get_nav_counts contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, no input", () => {
    expect(shellNavCountsGet.mutates).toBe(false);
    expect(shellNavCountsGet.noBillingGate).toBe(true);
    expect(shellNavCountsGet.scoped).toBe(true);
    expect(shellNavCountsGet.input.safeParse({ kinds: [] }).success).toBe(
      false,
    );
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(shellNavCountsGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(shellNavCountsGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "introspection",
    });
  });

  it("carries each count as a nullable non-negative integer", () => {
    const counts = {
      approvals: 3,
      interjections: 1,
      proposals: null,
      incidents: null,
    };
    expect(shellNavCountsGet.output.parse(counts)).toEqual(counts);
    expect(
      shellNavCountsGet.output.safeParse({ ...counts, approvals: -1 }).success,
    ).toBe(false);
    expect(
      shellNavCountsGet.output.safeParse({ approvals: 0, proposals: 0 })
        .success,
    ).toBe(false);
    const { interjections: _i, ...withoutInterjections } = counts;
    expect(
      shellNavCountsGet.output.safeParse(withoutInterjections).success,
    ).toBe(false);
  });
});
