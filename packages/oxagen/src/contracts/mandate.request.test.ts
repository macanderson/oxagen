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

  // The org branch names only real org-scoped roles: there is no org
  // "Member" role in this system (tools/scripts/seed-iam-defaults.ts's
  // ORG_ROLES is Owner/Admin/Compliance/Billing only), and it must match
  // ACCOUNTABLE_ORG_ROLES, the set the handler's own assertOrgRole call
  // admits — a narrower kernel-level grant would refuse an accountable
  // caller before the handler's own check ever runs (ADR-107, #3138).
  it("admits exactly the accountable org roles the handler's own assertOrgRole call does", () => {
    expect(mandateRequest.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
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
