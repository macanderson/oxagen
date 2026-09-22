import { describe, expect, it, vi } from "vitest";

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

import {
  parseStoredSsoConfig,
  sameSsoIssuer,
  sealSsoConfigOrRefuse,
  serializeSealedSsoConfig,
  ssoScopes,
  storedSsoOidcDiscovery,
  toSsoGroupRoles,
  toSsoProviderView,
  withSsoGroupsClaim,
} from "./sso";
import { ISSUER, SSO_BASE_URL, ssoRow } from "../test-utils/sso-fixtures";

const KMS = { adapter: {} as never, keyId: "sso_v1" };

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
