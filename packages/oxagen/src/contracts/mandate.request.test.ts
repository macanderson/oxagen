import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { SPEC_MANDATE_BODY as BODY } from "../mandates/schemas.sample";
import { mandateRequest } from "./mandate.request";

describe("request_mandate contract", () => {
  it("is the operator's ask: scoped, unmetered, open to workspace members, no approval on the agent surface", () => {
    expect(getCapability("request_mandate")).toBe(mandateRequest);
    expect(mandateRequest.scoped).toBe(true);
    expect(mandateRequest.noBillingGate).toBe(true);
    expect(mandateRequest.agent?.requiresApproval).toBe(false);
    expect(mandateRequest.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  it("takes the same body as grant_mandate and no requestId", () => {
    expect(mandateRequest.input.parse(BODY).purpose).toBe(BODY.purpose);
    expect(
      mandateRequest.input.safeParse({
        ...BODY,
        requestId: "mnd_0123456789abcdefghjkmn",
      }).success,
    ).toBe(false);
  });
});
