/**
 * Shared fixtures for the org.sso.* handler tests: a provider row, a fake
 * sealer that marks each secret the way the real one does, and a discovery
 * document.
 */
import type { SsoProviderRow } from "../lib/sso";

export const SSO_BASE_URL = "https://app.oxagen.sh";
export const ISSUER = "https://idp.acme.com";

type Json = Record<string, unknown>;

/**
 * Stands in for `sealSsoConfig`: every plaintext secret at `paths` becomes an
 * `enc:v1:` token, a sealed one is kept, and the JSON text is returned. The
 * tests pass the real `SSO_SECRET_PATHS`, and the real
 * `plaintextSsoSecretPaths` recognises the tokens, so a test that asserts
 * "no plaintext secret" is testing the handler, not the fake.
 */
export async function fakeSealSsoConfig(
  paths: readonly (readonly string[])[],
  config: Json,
): Promise<string> {
  const out = JSON.parse(JSON.stringify(config)) as Json;
  for (const path of paths) {
    let parent: Json | undefined = out;
    for (const key of path.slice(0, -1)) {
      const next: unknown = parent?.[key];
      parent =
        next !== null && typeof next === "object" ? (next as Json) : undefined;
    }
    const leaf = path[path.length - 1]!;
    const value = parent?.[leaf];
    if (typeof value !== "string" || value === "") continue;
    if (value.startsWith("enc:v1:")) continue;
    parent![leaf] =
      `enc:v1:sso_v1:${Buffer.from(`sealed(${value.length})`).toString("base64")}`;
  }
  return JSON.stringify(out);
}

export function ssoRow(
  overrides: Partial<SsoProviderRow> = {},
): SsoProviderRow {
  const now = new Date("2026-09-22T12:00:00.000Z");
  return {
    id: "row-1",
    issuer: ISSUER,
    oidcConfig: JSON.stringify({
      clientId: "client-1",
      clientSecret: "enc:v1:sso_v1:c3RvcmVk",
      discoveryEndpoint: `${ISSUER}/.well-known/openid-configuration`,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksEndpoint: `${ISSUER}/jwks`,
      tokenEndpointAuthentication: "client_secret_basic",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      mapping: { id: "sub", extraFields: { groups: "groups" } },
    }),
    samlConfig: null,
    userId: "u_1",
    providerId: "acme",
    organizationId: "org_1",
    domain: "acme.com",
    domainVerified: false,
    protocol: "oidc",
    displayName: "Acme",
    groupsClaim: "groups",
    domainVerificationToken: "tok123",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function discoveryDoc(overrides: Json = {}): Json {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
