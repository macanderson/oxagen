import { describe, expect, it } from "vitest";
import { orgSsoList } from "./org.sso.list";
import { getCapability } from "../registry";

describe("org.sso.list capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("list_sso_providers")).toBe(orgSsoList);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoList.scoped).toBe(false);
    expect(orgSsoList.sensitivity).toBe("high");
    expect(orgSsoList.defaultEffect).toBe("deny");
    expect(orgSsoList.noBillingGate).toBe(true);
    expect(orgSsoList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoList.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoList).toBe(false);
  });

  it("takes no input", () => {
    expect(orgSsoList.input.parse({})).toEqual({});
  });

  it("strips anything secret-shaped a handler bug might add to a view", () => {
    const out = orgSsoList.output.parse({
      providers: [
        {
          providerId: "acme",
          displayName: "Acme",
          protocol: "oidc",
          domain: "acme.com",
          domainVerified: false,
          issuer: "https://idp.acme.com",
          groupsClaim: "groups",
          domainVerification: {
            recordName: "_oxagen-sso.acme.com",
            recordValue: "oxagen-sso-verification=t",
          },
          callbackUrl: "https://app.oxagen.sh/api/auth/sso/callback/acme",
          spMetadataUrl: null,
          oidc: {
            clientId: "cid",
            clientSecretSet: true,
            scopes: ["openid"],
            clientSecret: "s3cret",
          },
          saml: null,
          groupRoles: [],
          createdAt: "2026-09-22T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z",
        },
      ],
      policy: { ssoRequired: false },
      entitled: true,
      scim: {
        baseUrl: "https://app.oxagen.sh/api/scim/v2",
        token: {
          tokenPrefix: "oxscim_abcdefgh",
          createdAt: "2026-09-23T00:00:00.000Z",
          lastUsedAt: null,
          tokenHash: "s3cret-hash",
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(out.scim.token).toEqual({
      tokenPrefix: "oxscim_abcdefgh",
      createdAt: "2026-09-23T00:00:00.000Z",
      lastUsedAt: null,
    });
  });

  it("requires the plan flag, so the page never has to guess it", () => {
    expect(
      orgSsoList.output.safeParse({
        providers: [],
        policy: { ssoRequired: false },
        scim: { baseUrl: "https://app.oxagen.sh/api/scim/v2", token: null },
      }).success,
    ).toBe(false);
    expect(
      orgSsoList.output.parse({
        providers: [],
        policy: { ssoRequired: false },
        entitled: false,
        scim: { baseUrl: "https://app.oxagen.sh/api/scim/v2", token: null },
      }).entitled,
    ).toBe(false);
  });

  it("requires the SCIM view, so the page always has a base URL to show", () => {
    expect(
      orgSsoList.output.safeParse({
        providers: [],
        policy: { ssoRequired: false },
        entitled: true,
      }).success,
    ).toBe(false);
  });
});
