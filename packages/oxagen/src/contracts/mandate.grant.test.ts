import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { SPEC_MANDATE_BODY as BODY } from "../mandates/schemas.sample";
import { mandateGrant } from "./mandate.grant";

describe("grant_mandate contract", () => {
  it("is a high-sensitivity governance write outside the metering surface, approval-gated on the agent surface", () => {
    expect(getCapability("grant_mandate")).toBe(mandateGrant);
    expect(mandateGrant.scoped).toBe(true);
    expect(mandateGrant.noBillingGate).toBe(true);
    expect(mandateGrant.sensitivity).toBe("high");
    expect(mandateGrant.agent?.requiresApproval).toBe(true);
    expect(mandateGrant.defaultEffect).toBe("deny");
    // An MCP call acts as the API key's creator (resolveActingUserId).
    expect(mandateGrant.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(mandateGrant.layers).toEqual([
      "schema",
      "api",
      "mcp",
      "unit",
      "docs",
    ]);
  });

  it("takes the spec body with an optional requestId and refuses two-person fields", () => {
    expect(mandateGrant.input.parse(BODY).requestId).toBeUndefined();
    expect(
      mandateGrant.input.parse({
        ...BODY,
        requestId: "mnd_0123456789abcdefghjkmn",
      }).requestId,
    ).toBe("mnd_0123456789abcdefghjkmn");
    expect(
      mandateGrant.input.safeParse({ ...BODY, requestId: "apr_x" }).success,
    ).toBe(false);
    expect(
      mandateGrant.input.safeParse({ ...BODY, secondApprover: "usr_x" })
        .success,
    ).toBe(false);
    expect(
      mandateGrant.input.safeParse({ ...BODY, validTo: BODY.validFrom })
        .success,
    ).toBe(false);
  });
});
