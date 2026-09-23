import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/database/sso-secrets", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@oxagen/database/sso-secrets")>();
  // A sealer that seals nothing, so the plaintext check after it has
  // something to refuse.
  return {
    ...real,
    sealSsoConfig: async (_protocol: string, config: unknown) =>
      JSON.stringify(config),
  };
});

// The plan behind the Enterprise check (ADR-144).
const plan = vi.hoisted(() => ({ resolveOrgTier: vi.fn() }));
vi.mock("@oxagen/billing", () => ({
  canAccessSSO: (tier: string) => tier === "enterprise",
  resolveOrgTier: plan.resolveOrgTier,
}));

import {
  discoverOidc,
  parseStoredSsoConfig,
  requireSsoEntitlement,
  sameSsoIssuer,
  sealSsoConfigOrRefuse,
  serializeSealedSsoConfig,
  setSsoDiscoveryFetchForTests,
  ssoScopes,
  storedSsoOidcDiscovery,
  toSsoGroupRoles,
  toSsoProviderView,
  withSsoGroupsClaim,
} from "./sso";
import {
  discoveryDoc,
  ISSUER,
  jsonResponse,
  SSO_BASE_URL,
  ssoRow,
} from "../test-utils/sso-fixtures";

const KMS = { adapter: {} as never, keyId: "sso_v1" };

describe("requireSsoEntitlement", () => {
  afterEach(() => {
    plan.resolveOrgTier.mockReset();
  });

  it("allows an organisation on the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("enterprise");
    await expect(
      requireSsoEntitlement({ orgId: "org_1" }),
    ).resolves.toBeUndefined();
  });

  it.each(["free", "build", "scale"] as const)(
    "refuses an organisation on the %s plan with the sso_requires_enterprise reason",
    async (tier) => {
      plan.resolveOrgTier.mockResolvedValue(tier);
      await expect(
        requireSsoEntitlement({ orgId: "org_1" }),
      ).rejects.toMatchObject({
        code: "forbidden",
        reason: "sso_requires_enterprise",
        message: expect.stringContaining("Enterprise plan"),
      });
    },
  );

  it("reads the tier the kernel already resolved, without a lookup", async () => {
    plan.resolveOrgTier.mockResolvedValue("free");
    await expect(
      requireSsoEntitlement({ orgId: "org_1", planTier: "enterprise" }),
    ).resolves.toBeUndefined();
    await expect(
      requireSsoEntitlement({ orgId: "org_1", planTier: "scale" }),
    ).rejects.toMatchObject({ reason: "sso_requires_enterprise" });
    expect(plan.resolveOrgTier).not.toHaveBeenCalled();
  });

  it("looks the tier up by organisation when the context has none", async () => {
    plan.resolveOrgTier.mockResolvedValue("enterprise");
    await requireSsoEntitlement({ orgId: "org_1" });
    expect(plan.resolveOrgTier).toHaveBeenCalledWith("org_1");
  });
});

describe("ssoScopes", () => {
  it("asks for openid, email and profile first, and each scope once", () => {
    expect(ssoScopes(undefined)).toEqual(["openid", "email", "profile"]);
    expect(ssoScopes(["groups", "email", "groups"])).toEqual([
      "openid",
      "email",
      "profile",
      "groups",
    ]);
  });
});

describe("parseStoredSsoConfig", () => {
  it("reads an object and turns anything else into an empty config", () => {
    expect(parseStoredSsoConfig('{"a":1}')).toEqual({ a: 1 });
    expect(parseStoredSsoConfig(null)).toEqual({});
    expect(parseStoredSsoConfig("not json")).toEqual({});
    expect(parseStoredSsoConfig("[1,2]")).toEqual({});
    expect(parseStoredSsoConfig("null")).toEqual({});
  });
});

describe("withSsoGroupsClaim", () => {
  it("sets the groups mapping and keeps the rest", () => {
    expect(
      withSsoGroupsClaim(
        {
          clientSecret: "enc:v1:x",
          mapping: { id: "sub", extraFields: { a: "b" } },
        },
        "roles",
      ),
    ).toEqual({
      clientSecret: "enc:v1:x",
      mapping: { id: "sub", extraFields: { a: "b", groups: "roles" } },
    });
  });

  it("creates the mapping when the stored config has none", () => {
    expect(withSsoGroupsClaim({}, "groups")).toEqual({
      mapping: { extraFields: { groups: "groups" } },
    });
  });
});

describe("storedSsoOidcDiscovery", () => {
  const stored = JSON.parse(ssoRow().oidcConfig!) as Record<string, unknown>;

  it("returns the endpoints a stored config already holds", () => {
    expect(storedSsoOidcDiscovery(stored, ISSUER)).toEqual({
      issuer: ISSUER,
      discoveryEndpoint: `${ISSUER}/.well-known/openid-configuration`,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksEndpoint: `${ISSUER}/jwks`,
      tokenEndpointAuthentication: "client_secret_basic",
    });
  });

  it("returns null when an endpoint or the auth method is missing, so discovery runs again", () => {
    const { tokenEndpoint: _drop, ...noToken } = stored;
    expect(storedSsoOidcDiscovery(noToken, ISSUER)).toBeNull();
    expect(
      storedSsoOidcDiscovery(
        { ...stored, tokenEndpointAuthentication: "private_key_jwt" },
        ISSUER,
      ),
    ).toBeNull();
  });
});

describe("sameSsoIssuer", () => {
  it("ignores a trailing slash and nothing else", () => {
    expect(sameSsoIssuer(ISSUER, `${ISSUER}/`)).toBe(true);
    expect(sameSsoIssuer(ISSUER, "https://other.example")).toBe(false);
  });
});

describe("plaintext refusals", () => {
  it("refuses to store a config the sealer left a secret in", async () => {
    await expect(
      sealSsoConfigOrRefuse("oidc", { clientSecret: "plain" }, KMS),
    ).rejects.toThrow(/clientSecret would be stored in plaintext/);
  });

  it("refuses to re-serialize a config that holds a plaintext secret", () => {
    expect(() =>
      serializeSealedSsoConfig("saml", { spMetadata: { privateKey: "plain" } }),
    ).toThrow(/spMetadata.privateKey would be stored in plaintext/);
    expect(
      serializeSealedSsoConfig("oidc", { clientSecret: "enc:v1:sso_v1:x" }),
    ).toBe('{"clientSecret":"enc:v1:sso_v1:x"}');
  });
});

describe("toSsoProviderView", () => {
  it("still returns a view for a row whose stored config is unreadable", () => {
    const view = toSsoProviderView(
      ssoRow({ oidcConfig: "not json" }),
      [],
      SSO_BASE_URL,
    );
    expect(view.oidc).toEqual({
      clientId: "",
      clientSecretSet: false,
      scopes: [],
    });
  });

  it("reports a plaintext secret as set without returning it", () => {
    const view = toSsoProviderView(
      ssoRow({ oidcConfig: JSON.stringify({ clientSecret: "legacy-plain" }) }),
      [],
      SSO_BASE_URL,
    );
    expect(view.oidc?.clientSecretSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("legacy-plain");
  });
});

describe("toSsoGroupRoles", () => {
  it("keeps only the given provider's rows", () => {
    expect(
      toSsoGroupRoles(
        [
          { providerId: "acme", idpGroup: "eng", role: "member" },
          { providerId: "other", idpGroup: "ops", role: "admin" },
        ],
        "acme",
      ),
    ).toEqual([{ group: "eng", role: "member" }]);
  });
});

describe("discoverOidc", () => {
  const CAP = "create_sso_provider";
  const serve = (response: () => Response) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response());
    setSsoDiscoveryFetchForTests(fetch);
    return fetch;
  };
  afterEach(() => setSsoDiscoveryFetchForTests(null));

  it("reads the well-known document under the issuer and returns its endpoints", async () => {
    const fetch = serve(() => jsonResponse(discoveryDoc()));
    await expect(discoverOidc(CAP, `${ISSUER}/`)).resolves.toEqual({
      issuer: ISSUER,
      discoveryEndpoint: `${ISSUER}/.well-known/openid-configuration`,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksEndpoint: `${ISSUER}/jwks`,
      userInfoEndpoint: `${ISSUER}/userinfo`,
      tokenEndpointAuthentication: "client_secret_basic",
    });
    expect(fetch).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("omits userinfo when the provider publishes none", async () => {
    serve(() => jsonResponse(discoveryDoc({ userinfo_endpoint: undefined })));
    const found = await discoverOidc(CAP, ISSUER);
    expect(found).not.toHaveProperty("userInfoEndpoint");
  });

  it("chooses basic when the provider lists no auth methods", async () => {
    serve(() =>
      jsonResponse(
        discoveryDoc({ token_endpoint_auth_methods_supported: undefined }),
      ),
    );
    await expect(discoverOidc(CAP, ISSUER)).resolves.toMatchObject({
      tokenEndpointAuthentication: "client_secret_basic",
    });
  });

  it.each([
    [
      "a private userinfo endpoint",
      { userinfo_endpoint: "https://10.0.0.5/u" },
    ],
    ["a plain-http jwks_uri", { jwks_uri: "http://idp.acme.com/jwks" }],
    [
      "a metadata-address authorization endpoint",
      { authorization_endpoint: "https://169.254.169.254/authorize" },
    ],
  ])("refuses a document naming %s", async (_label, overrides) => {
    serve(() => jsonResponse(discoveryDoc(overrides)));
    await expect(discoverOidc(CAP, ISSUER)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses an endpoint that is not a string", async () => {
    serve(() => jsonResponse(discoveryDoc({ token_endpoint: 42 })));
    await expect(discoverOidc(CAP, ISSUER)).rejects.toThrow(
      /token_endpoint is not a URL/,
    );
  });

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["a JSON array", () => jsonResponse([discoveryDoc()])],
    ["JSON null", () => jsonResponse(null)],
  ])("refuses a document that is %s", async (_label, response) => {
    serve(response);
    await expect(discoverOidc(CAP, ISSUER)).rejects.toThrow(
      /is not valid JSON/,
    );
  });

  it("refuses a document with no issuer", async () => {
    serve(() => jsonResponse(discoveryDoc({ issuer: undefined })));
    await expect(discoverOidc(CAP, ISSUER)).rejects.toThrow(
      /names the issuer null/,
    );
  });

  it("refuses an issuer that differs by more than a trailing slash", async () => {
    serve(() => jsonResponse(discoveryDoc({ issuer: `${ISSUER}/tenant` })));
    await expect(discoverOidc(CAP, ISSUER)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("does not fetch at all for a private issuer", async () => {
    const fetch = serve(() => jsonResponse(discoveryDoc()));
    await expect(
      discoverOidc(CAP, "https://[::ffff:127.0.0.1]"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
