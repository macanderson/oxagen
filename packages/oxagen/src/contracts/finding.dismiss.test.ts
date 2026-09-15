import { describe, expect, it } from "vitest";
import { findingDismiss } from "./finding.dismiss";

describe("dismiss_finding contract", () => {
  it("is a mutating console write that never meters (INV-28)", () => {
    expect(findingDismiss.mutates).toBe(true);
    expect(findingDismiss.noBillingGate).toBe(true);
  });

  it("is not offered to an agent", () => {
    expect(findingDismiss.surfaces).not.toContain("agent");
  });

  it("addresses a finding by its public id only", () => {
    expect(
      findingDismiss.input.safeParse({
        findingId: "fnd_0123456789abcdefghjkmn",
      }).success,
    ).toBe(true);
    expect(findingDismiss.input.safeParse({}).success).toBe(false);
    expect(
      findingDismiss.input.safeParse({
        findingId: "0192d4a8-7c1e-7a00-8000-000000000001",
      }).success,
    ).toBe(false);
  });
});
