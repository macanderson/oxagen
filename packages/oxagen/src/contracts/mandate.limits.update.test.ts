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

  // ADR-102. `limits` replaces the record and is the only way to delete a
  // bound; `limitChanges` names the measures to change and the handler merges
  // it under the row lock. A request carrying both states two intentions for
  // one field, so it is invalid rather than resolved in favour of either.
  it("takes a limit change on its own, and never beside a whole record", () => {
    expect(
      mandateLimitsUpdate.input.parse({
        mandateId: ID,
        limitChanges: { amount: { perPeriod: "500000000" } },
      }).limitChanges?.amount?.perPeriod,
    ).toBe("500000000");
    expect(
      mandateLimitsUpdate.input.safeParse({
        mandateId: ID,
        limits: {
          amount: { perCall: "1", period: "daily", currencyOrUnit: "USD" },
        },
        limitChanges: { amount: { perPeriod: "2" } },
      }).success,
    ).toBe(false);
  });

  it("refuses a change that names no measure or no field (negative)", () => {
    expect(
      mandateLimitsUpdate.input.safeParse({ mandateId: ID, limitChanges: {} })
        .success,
    ).toBe(false);
    expect(
      mandateLimitsUpdate.input.safeParse({
        mandateId: ID,
        limitChanges: { amount: {} },
      }).success,
    ).toBe(false);
    // A figure is still an integer string: a change is not a way around INV-09.
    expect(
      mandateLimitsUpdate.input.safeParse({
        mandateId: ID,
        limitChanges: { amount: { perPeriod: "50.5" } },
      }).success,
    ).toBe(false);
  });
});
