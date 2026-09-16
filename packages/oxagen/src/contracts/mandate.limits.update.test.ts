import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { mandateLimitsUpdate } from "./mandate.limits.update";

const ID = "mnd_0123456789abcdefghjkmn";

describe("update_mandate_limits contract", () => {
  it("is a high-sensitivity governance write, approval-gated on the agent surface", () => {
    expect(getCapability("update_mandate_limits")).toBe(mandateLimitsUpdate);
    expect(mandateLimitsUpdate.noBillingGate).toBe(true);
    expect(mandateLimitsUpdate.sensitivity).toBe("high");
    expect(mandateLimitsUpdate.agent?.requiresApproval).toBe(true);
  });

  it("names at least one change and refuses the fields Change limits does not own", () => {
    expect(mandateLimitsUpdate.input.safeParse({ mandateId: ID }).success).toBe(
      false,
    );
    expect(
      mandateLimitsUpdate.input.parse({
        mandateId: ID,
        limits: {
          amount: { perCall: "1", period: "daily", currencyOrUnit: "USD" },
        },
      }).limits?.amount?.perCall,
    ).toBe("1");
    expect(
      mandateLimitsUpdate.input.parse({
        mandateId: ID,
        validTo: "2027-01-01T00:00:00Z",
      }).validTo,
    ).toBe("2027-01-01T00:00:00Z");
    expect(
      mandateLimitsUpdate.input.safeParse({ mandateId: ID, tools: ["x"] })
        .success,
    ).toBe(false);
    expect(
      mandateLimitsUpdate.input.safeParse({
        mandateId: ID,
        consequenceTags: ["moves_money"],
      }).success,
    ).toBe(false);
  });
});
