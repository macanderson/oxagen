import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  resolveKms: vi.fn(),
  insert: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));
vi.mock("@oxagen/database/sso-secrets", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@oxagen/database/sso-secrets")>();
  const { fakeSealSsoConfig } = await import("./test-utils/sso-fixtures");
  return {
    ...real,
    resolveSsoKms: mocks.resolveKms,
    sealSsoConfig: (
      protocol: "oidc" | "saml",
      config: Record<string, unknown>,
    ) => fakeSealSsoConfig(real.SSO_SECRET_PATHS[protocol], config),
  };
});
vi.mock("./lib/sso-store", () => ({
  insertOrgSsoProvider: mocks.insert,
}));

// The org-role gate every SSO handler asserts (INV-29). Allows by default, an
// org Admin, so each case tests its own behaviour; the refusal case sets
// `roleGate.refuse` and asserts nothing else ran.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { plaintextSsoSecretPaths } from "@oxagen/database/sso-secrets";
import { orgSsoCreateHandler } from "./org.sso.create";
import { setSsoDiscoveryFetchForTests } from "./lib/sso";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import {
  discoveryDoc,
  ISSUER,
  jsonResponse,
  SSO_BASE_URL,
} from "./test-utils/sso-fixtures";

const CLIENT_SECRET = "oidc-client-secret-do-not-store";
const SP_KEY = "-----BEGIN PRIVATE KEY-----sp-key-do-not-store";

const OIDC_INPUT = {
  providerId: "acme",
  displayName: "Acme",
  domain: "acme.com",
  config: {
    protocol: "oidc" as const,
    issuer: ISSUER,
    clientId: "client-1",
    clientSecret: CLIENT_SECRET,
    scopes: ["groups", "openid"],
  },
};

const SAML_INPUT = {
  providerId: "acme-saml",
  displayName: "Acme SAML",
  domain: "acme.com",
  groupsClaim: "memberOf",
  config: {
    protocol: "saml" as const,
    issuer: "urn:acme:idp",
    entryPoint: "https://idp.acme.com/saml/sso",
    cert: "-----BEGIN CERTIFICATE-----idp",
    spPrivateKey: SP_KEY,
  },
};

const discoveryFetch = vi.fn();

function storedValues(): Record<string, unknown> {
  return mocks.insert.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  process.env.BETTER_AUTH_URL = `${SSO_BASE_URL}/`;
  mocks.resolveKms.mockReturnValue({ adapter: {}, keyId: "sso_v1" });
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.insert.mockImplementation(async (_tx, values) => ({
    ...values,
    createdAt: new Date("2026-09-22T12:00:00.000Z"),
    updatedAt: new Date("2026-09-22T12:00:00.000Z"),
  }));
  discoveryFetch.mockReset();
  discoveryFetch.mockImplementation(async () => jsonResponse(discoveryDoc()));
  setSsoDiscoveryFetchForTests(discoveryFetch);
});

afterEach(() => {
  setSsoDiscoveryFetchForTests(null);
});

describe("org.sso.create handler", () => {
  it("refuses a caller who is not an org Owner or Admin, before anything else runs", async () => {
    roleGate.refuse = true;
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /forbidden/,
    );
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId }),
      { org: ["Owner", "Admin"] },
    );
    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("refuses to store a provider when no KMS is configured, before any network read", async () => {
    mocks.resolveKms.mockReturnValue(null);
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /Refusing to store them in plaintext/,
    );
    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("stores an OIDC config with the secret sealed and the groups claim mapped", async () => {
    const out = await orgSsoCreateHandler(OIDC_INPUT, CTX);

    expect(discoveryFetch).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const values = storedValues();
    expect(values["organizationId"]).toBe(CTX.orgId);
    expect(values["userId"]).toBe(CTX.userId);
    expect(values["domainVerified"]).toBe(false);
    expect(values["samlConfig"]).toBeNull();
    expect(values["domainVerificationToken"]).toMatch(/^[0-9a-f]{48}$/);

    const text = values["oidcConfig"] as string;
    expect(text).not.toContain(CLIENT_SECRET);
    const config = JSON.parse(text) as Record<string, unknown>;
    expect(plaintextSsoSecretPaths("oidc", config)).toEqual([]);
    expect(config["clientSecret"]).toMatch(/^enc:v1:/);
    expect(config).toMatchObject({
      clientId: "client-1",
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksEndpoint: `${ISSUER}/jwks`,
      userInfoEndpoint: `${ISSUER}/userinfo`,
      tokenEndpointAuthentication: "client_secret_basic",
      pkce: true,
      scopes: ["openid", "email", "profile", "groups"],
      mapping: { extraFields: { groups: "groups" } },
    });

    expect(out.provider).toMatchObject({
      providerId: "acme",
      protocol: "oidc",
      domainVerified: false,
      callbackUrl: `${SSO_BASE_URL}/api/auth/sso/callback/acme`,
      spMetadataUrl: null,
      oidc: { clientId: "client-1", clientSecretSet: true },
      domainVerification: {
        recordName: "_oxagen-sso.acme.com",
      },
    });
    expect(JSON.stringify(out)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(out)).not.toContain("enc:v1:");
  });

  it("chooses client_secret_post when the provider does not list basic", async () => {
    discoveryFetch.mockImplementation(async () =>
      jsonResponse(
        discoveryDoc({
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        }),
      ),
    );
    await orgSsoCreateHandler(OIDC_INPUT, CTX);
    const config = JSON.parse(storedValues()["oidcConfig"] as string);
    expect(config.tokenEndpointAuthentication).toBe("client_secret_post");
  });

  it("stores a SAML config with the SP key sealed and the groups attribute mapped", async () => {
    const out = await orgSsoCreateHandler(SAML_INPUT, CTX);

    expect(discoveryFetch).not.toHaveBeenCalled();
    const values = storedValues();
    expect(values["issuer"]).toBe("urn:acme:idp");
    expect(values["oidcConfig"]).toBeNull();
    expect(values["groupsClaim"]).toBe("memberOf");

    const text = values["samlConfig"] as string;
    expect(text).not.toContain(SP_KEY);
    const config = JSON.parse(text) as Record<string, unknown> & {
      privateKey?: string;
      spMetadata: { privateKey?: string };
    };
    expect(plaintextSsoSecretPaths("saml", config)).toEqual([]);
    const entityId = `${SSO_BASE_URL}/api/auth/sso/saml2/sp/metadata?providerId=acme-saml`;
    expect(config).toMatchObject({
      entryPoint: "https://idp.acme.com/saml/sso",
      audience: entityId,
      spMetadata: { entityID: entityId },
      idpMetadata: { entityID: "urn:acme:idp" },
      wantAssertionsSigned: true,
      authnRequestsSigned: true,
      mapping: { extraFields: { groups: "memberOf" } },
    });
    expect(config.privateKey).toMatch(/^enc:v1:/);
    expect(config.spMetadata.privateKey).toMatch(/^enc:v1:/);

    expect(out.provider).toMatchObject({
      protocol: "saml",
      callbackUrl: `${SSO_BASE_URL}/api/auth/sso/saml2/sp/acs/acme-saml`,
      spMetadataUrl: entityId,
      saml: { spPrivateKeySet: true },
      oidc: null,
    });
    expect(JSON.stringify(out)).not.toContain(SP_KEY);
  });

  it("does not sign AuthnRequests when no SP key is given", async () => {
    const { spPrivateKey: _omit, ...config } = SAML_INPUT.config;
    await orgSsoCreateHandler({ ...SAML_INPUT, config }, CTX);
    const stored = JSON.parse(storedValues()["samlConfig"] as string);
    expect(stored.authnRequestsSigned).toBe(false);
    expect(stored).not.toHaveProperty("privateKey");
  });

  it.each([
    ["an http issuer", "http://idp.acme.com"],
    ["a loopback issuer", "https://127.0.0.1"],
    ["the metadata address", "https://169.254.169.254"],
  ])("refuses %s before any network read", async (_label, issuer) => {
    await expect(
      orgSsoCreateHandler(
        { ...OIDC_INPUT, config: { ...OIDC_INPUT.config, issuer } },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses a discovery document that names a private token endpoint", async () => {
    discoveryFetch.mockImplementation(async () =>
      jsonResponse(discoveryDoc({ token_endpoint: "https://10.0.0.5/token" })),
    );
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses a discovery document for another issuer", async () => {
    discoveryFetch.mockImplementation(async () =>
      jsonResponse(discoveryDoc({ issuer: "https://evil.example" })),
    );
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /names the issuer "https:\/\/evil.example"/,
    );
  });

  it("refuses a discovery document with no jwks_uri", async () => {
    discoveryFetch.mockImplementation(async () =>
      jsonResponse(discoveryDoc({ jwks_uri: undefined })),
    );
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /has no jwks_uri/,
    );
  });

  it("refuses when the discovery read fails", async () => {
    discoveryFetch.mockImplementation(async () => jsonResponse({}, 404));
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /returned HTTP 404/,
    );
    discoveryFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toThrow(
      /Could not read the discovery document/,
    );
  });

  it("accepts an issuer entered without the trailing slash the IdP publishes, and stores the IdP's spelling", async () => {
    discoveryFetch.mockImplementation(async () =>
      jsonResponse(discoveryDoc({ issuer: `${ISSUER}/` })),
    );
    await orgSsoCreateHandler(OIDC_INPUT, CTX);
    expect(storedValues()["issuer"]).toBe(`${ISSUER}/`);
  });

  it("maps a taken provider id and a taken domain to distinct conflicts", async () => {
    mocks.insert.mockRejectedValueOnce(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint_name: "sso_providers_provider_id_idx",
      }),
    );
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "provider_id_taken",
    });

    mocks.insert.mockRejectedValueOnce(
      new Error("Failed query", {
        cause: Object.assign(new Error("dup"), {
          code: "23505",
          constraint_name: "sso_providers_domain_idx",
        }),
      }),
    );
    await expect(orgSsoCreateHandler(OIDC_INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "domain_taken",
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("emits sso.provider_created naming the provider and never its config", async () => {
    await orgSsoCreateHandler(OIDC_INPUT, CTX);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.provider_created",
        orgId: CTX.orgId,
        actorUserId: CTX.userId,
        capability: "create_sso_provider",
        outcome: "success",
        detail: { providerId: "acme", protocol: "oidc", domain: "acme.com" },
      }),
    );
    expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain(CLIENT_SECRET);
  });
});
