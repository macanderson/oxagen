import { describe, expect, it } from "vitest";
import { scimRequest } from "./scim.request";
import { getCapability } from "../registry";

describe("scim.request capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("execute_scim_request")).toBe(scimRequest);
  });

  it("is reachable only by the SCIM route: no surface, no roles, the token authorizes", () => {
    expect(scimRequest.surfaces).toEqual([]);
    expect(scimRequest.defaultEffect).toBe("allow");
    expect(scimRequest.defaultRoles).toEqual({ org: {}, workspace: {} });
    expect(scimRequest.scoped).toBe(false);
    expect(scimRequest.noBillingGate).toBe(true);
    expect("agent" in scimRequest).toBe(false);
  });

  it("takes the token id, the method, the path, the query and a body", () => {
    const input = scimRequest.input.parse({
      tokenId: "00000000-0000-4000-8000-000000000001",
      method: "PATCH",
      path: "/Users/00000000-0000-4000-8000-0000000000aa",
      body: { Operations: [] },
    });
    expect(input.query).toEqual({});
    expect(
      scimRequest.input.safeParse({
        tokenId: "not-a-uuid",
        method: "GET",
        path: "/Users",
      }).success,
    ).toBe(false);
    expect(
      scimRequest.input.safeParse({
        tokenId: "00000000-0000-4000-8000-000000000001",
        method: "HEAD",
        path: "/Users",
      }).success,
    ).toBe(false);
  });

  it("answers a status, a body and an optional Location", () => {
    expect(scimRequest.output.parse({ status: 204, body: null })).toEqual({
      status: 204,
      body: null,
    });
    expect(
      scimRequest.output.safeParse({ status: 99, body: null }).success,
    ).toBe(false);
  });
});
