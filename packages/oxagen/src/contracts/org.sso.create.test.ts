import { describe, expect, it } from "vitest";
import { orgSsoCreate } from "./org.sso.create";
import { getCapability } from "../registry";

describe("org.sso.create capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("create_sso_provider")).toBe(orgSsoCreate);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoCreate.scoped).toBe(false);
    expect(orgSsoCreate.sensitivity).toBe("high");
    expect(orgSsoCreate.defaultEffect).toBe("deny");
    expect(orgSsoCreate.noBillingGate).toBe(true);
    expect(orgSsoCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoCreate.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoCreate).toBe(false);
  });

  const base = {
    providerId: "acme",
    displayName: "Acme",
    domain: "Acme.COM",
    config: {
      protocol: "oidc" as const,
      issuer: "https://idp.acme.com",
      clientId: "cid",
      clientSecret: "secret",
    },
  };

  it("lowercases the domain", () => {
    expect(orgSsoCreate.input.parse(base).domain).toBe("acme.com");
  });

  it("refuses an OIDC issuer on a private address", () => {
    const res = orgSsoCreate.input.safeParse({
      ...base,
      config: { ...base.config, issuer: "https://169.254.169.254" },
    });
    expect(res.success).toBe(false);
  });

  it("refuses an http issuer", () => {
    const res = orgSsoCreate.input.safeParse({
      ...base,
      config: { ...base.config, issuer: "http://idp.acme.com" },
    });
    expect(res.success).toBe(false);
  });

  it("accepts SAML settings without an SP key", () => {
    const res = orgSsoCreate.input.safeParse({
      ...base,
      config: {
        protocol: "saml",
        issuer: "urn:acme:idp",
        entryPoint: "https://idp.acme.com/sso",
        cert: "-----BEGIN CERTIFICATE-----x",
      },
    });
    expect(res.success).toBe(true);
  });

  it("refuses a provider id that is not a slug", () => {
    expect(
      orgSsoCreate.input.safeParse({ ...base, providerId: "Acme SSO" }).success,
    ).toBe(false);
  });
});
