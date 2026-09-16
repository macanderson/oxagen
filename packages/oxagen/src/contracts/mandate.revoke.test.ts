import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { mandateRevoke } from "./mandate.revoke";

describe("revoke_mandate contract", () => {
  it("is a high-sensitivity governance write, approval-gated on the agent surface", () => {
    expect(getCapability("revoke_mandate")).toBe(mandateRevoke);
    expect(mandateRevoke.noBillingGate).toBe(true);
    expect(mandateRevoke.sensitivity).toBe("high");
    expect(mandateRevoke.agent?.requiresApproval).toBe(true);
  });

  it("requires a reason", () => {
    expect(
      mandateRevoke.input.parse({
        mandateId: "mnd_0123456789abcdefghjkmn",
        reason: "PO closed",
      }).reason,
    ).toBe("PO closed");
    expect(
      mandateRevoke.input.safeParse({
        mandateId: "mnd_0123456789abcdefghjkmn",
        reason: "",
      }).success,
    ).toBe(false);
    expect(
      mandateRevoke.input.safeParse({ mandateId: "mnd_0123456789abcdefghjkmn" })
        .success,
    ).toBe(false);
  });
});
