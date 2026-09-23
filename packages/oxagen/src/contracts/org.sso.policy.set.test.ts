import { describe, expect, it } from "vitest";
import { orgSsoPolicySet } from "./org.sso.policy.set";
import { getCapability } from "../registry";

describe("org.sso.policy.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_sso_policy")).toBe(orgSsoPolicySet);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoPolicySet.scoped).toBe(false);
    expect(orgSsoPolicySet.sensitivity).toBe("high");
    expect(orgSsoPolicySet.defaultEffect).toBe("deny");
    expect(orgSsoPolicySet.noBillingGate).toBe(true);
    expect(orgSsoPolicySet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoPolicySet.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoPolicySet).toBe(false);
  });

  it("takes a boolean", () => {
    expect(orgSsoPolicySet.input.parse({ ssoRequired: true })).toEqual({
      ssoRequired: true,
    });
    expect(
      orgSsoPolicySet.input.safeParse({ ssoRequired: "yes" }).success,
    ).toBe(false);
  });
});
