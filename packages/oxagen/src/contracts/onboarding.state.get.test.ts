import { describe, expect, it } from "vitest";
import { onboardingStateGet } from "./onboarding.state.get";

const OPEN = {
  step: "wrap",
  workspace: { id: "wrk_0123456789", slug: "core" },
  firstFrameAt: null,
  firstRunId: null,
  provisional: {
    until: "2026-09-29T12:00:00.000Z",
    mainRepoBoundAt: null,
    detectedRepository: null,
  },
};

describe("get_onboarding_state contract", () => {
  it("is an unscoped console read: mutates false, noBillingGate true, allow by default", () => {
    expect(onboardingStateGet.scoped).toBe(false);
    expect(onboardingStateGet.mutates).toBe(false);
    expect(onboardingStateGet.noBillingGate).toBe(true);
    expect(onboardingStateGet.defaultEffect).toBe("allow");
    expect(onboardingStateGet.surfaces).toEqual(["api", "mcp"]);
  });

  it("takes no input and refuses an unknown key", () => {
    expect(onboardingStateGet.input.parse({})).toEqual({});
    expect(onboardingStateGet.input.safeParse({ orgId: "x" }).success).toBe(
      false,
    );
  });

  it("answers the pre-org shape, an open gate, and an unlocked gate with its first frame", () => {
    expect(
      onboardingStateGet.output.parse({
        step: "organization",
        workspace: null,
        firstFrameAt: null,
        firstRunId: null,
        provisional: null,
      }).step,
    ).toBe("organization");
    expect(onboardingStateGet.output.parse(OPEN)).toEqual(OPEN);
    const unlocked = {
      ...OPEN,
      step: "unlocked",
      firstFrameAt: "2026-09-15T12:05:00.000Z",
      firstRunId: "tse_0123456789",
      provisional: {
        ...OPEN.provisional,
        detectedRepository: { provider: "github", owner: "acme", name: "w" },
      },
    };
    expect(onboardingStateGet.output.parse(unlocked)).toEqual(unlocked);
  });

  it("refuses a step outside the four, a non-workspace id, and a provider other than GitHub", () => {
    expect(
      onboardingStateGet.output.safeParse({ ...OPEN, step: "signup" }).success,
    ).toBe(false);
    expect(
      onboardingStateGet.output.safeParse({
        ...OPEN,
        workspace: { id: "ws-uuid", slug: "core" },
      }).success,
    ).toBe(false);
    expect(
      onboardingStateGet.output.safeParse({
        ...OPEN,
        provisional: {
          ...OPEN.provisional,
          detectedRepository: { provider: "gitlab", owner: "a", name: "b" },
        },
      }).success,
    ).toBe(false);
  });
});
