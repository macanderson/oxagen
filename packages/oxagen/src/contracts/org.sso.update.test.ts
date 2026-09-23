import { describe, expect, it } from "vitest";
import { orgSsoUpdate } from "./org.sso.update";
import { getCapability } from "../registry";

describe("org.sso.update capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("update_sso_provider")).toBe(orgSsoUpdate);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoUpdate.scoped).toBe(false);
    expect(orgSsoUpdate.sensitivity).toBe("high");
    expect(orgSsoUpdate.defaultEffect).toBe("deny");
    expect(orgSsoUpdate.noBillingGate).toBe(true);
    expect(orgSsoUpdate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoUpdate.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoUpdate).toBe(false);
  });

  it("lets an OIDC update leave the client secret out", () => {
    const res = orgSsoUpdate.input.safeParse({
      providerId: "acme",
      config: {
        protocol: "oidc",
        issuer: "https://idp.acme.com",
        clientId: "cid",
      },
    });
    expect(res.success).toBe(true);
  });

  it("accepts a name-only change", () => {
    expect(
      orgSsoUpdate.input.parse({ providerId: "acme", displayName: "Acme" }),
    ).toEqual({ providerId: "acme", displayName: "Acme" });
  });

  it("refuses a private issuer on update too", () => {
    const res = orgSsoUpdate.input.safeParse({
      providerId: "acme",
      config: { protocol: "oidc", issuer: "https://10.0.0.5", clientId: "cid" },
    });
    expect(res.success).toBe(false);
  });

  it("has no domain field: a domain change is a delete and a create", () => {
    const out = orgSsoUpdate.input.parse({
      providerId: "acme",
      domain: "evil.com",
    });
    expect(out).not.toHaveProperty("domain");
  });
});
