import { describe, expect, it } from "vitest";
import { onboardingAdvance } from "./onboarding.advance";

describe("advance_onboarding contract", () => {
  it("is a scoped settings write: mutates true, noBillingGate true, Owner/Admin", () => {
    expect(onboardingAdvance.scoped).toBe(true);
    expect(onboardingAdvance.mutates).toBe(true);
    expect(onboardingAdvance.noBillingGate).toBe(true);
    expect(onboardingAdvance.defaultEffect).toBe("deny");
    expect(onboardingAdvance.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("accepts wrap, run and unlocked as targets (the handler refuses unlocked) and nothing else", () => {
    for (const to of ["wrap", "run", "unlocked"]) {
      expect(onboardingAdvance.input.parse({ to })).toEqual({ to });
    }
    expect(
      onboardingAdvance.input.safeParse({ to: "organization" }).success,
    ).toBe(false);
    expect(onboardingAdvance.input.safeParse({}).success).toBe(false);
    expect(
      onboardingAdvance.input.safeParse({ to: "run", force: true }).success,
    ).toBe(false);
  });

  it("answers the step it landed on and when", () => {
    const out = { step: "run", changedAt: "2026-09-15T12:00:00.000Z" };
    expect(onboardingAdvance.output.parse(out)).toEqual(out);
    expect(
      onboardingAdvance.output.safeParse({ step: "run", changedAt: "today" })
        .success,
    ).toBe(false);
  });
});
