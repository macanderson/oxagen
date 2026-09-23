import { describe, expect, it } from "vitest";
import { orgSsoVerifyDomain } from "./org.sso.verify_domain";
import { getCapability } from "../registry";

describe("org.sso.verify_domain capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("verify_sso_domain")).toBe(orgSsoVerifyDomain);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoVerifyDomain.scoped).toBe(false);
    expect(orgSsoVerifyDomain.sensitivity).toBe("high");
    expect(orgSsoVerifyDomain.defaultEffect).toBe("deny");
    expect(orgSsoVerifyDomain.noBillingGate).toBe(true);
    expect(orgSsoVerifyDomain.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoVerifyDomain.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoVerifyDomain).toBe(false);
  });

  it("takes a provider id", () => {
    expect(orgSsoVerifyDomain.input.parse({ providerId: "acme" })).toEqual({
      providerId: "acme",
    });
    expect(orgSsoVerifyDomain.input.safeParse({}).success).toBe(false);
  });
});
