import { describe, expect, it } from "vitest";
import { orgScimTokenRevoke } from "./org.scim_token.revoke";
import { getCapability } from "../registry";

describe("org.scim_token.revoke capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("revoke_scim_token")).toBe(orgScimTokenRevoke);
  });

  it("is governed: org Owner or Admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgScimTokenRevoke.scoped).toBe(false);
    expect(orgScimTokenRevoke.sensitivity).toBe("high");
    expect(orgScimTokenRevoke.defaultEffect).toBe("deny");
    expect(orgScimTokenRevoke.noBillingGate).toBe(true);
    expect(orgScimTokenRevoke.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgScimTokenRevoke.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool", () => {
    expect("agent" in orgScimTokenRevoke).toBe(false);
  });

  it("takes no input", () => {
    expect(orgScimTokenRevoke.input.parse({})).toEqual({});
  });
});
