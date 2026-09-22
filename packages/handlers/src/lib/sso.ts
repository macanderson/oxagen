/**
 * Helpers shared by the org.sso.* handlers (ADR-142): the OIDC discovery read,
 * the allowlisted config builders, the sealing step and the provider view.
 *
 * The configs built here are what the @better-auth/sso plugin parses on every
 * sign-in. They are built from an allowlist rather than from the input, so a
 * field the admin did not mean to set never reaches the plugin, and every
 * secret-bearing field is one `SSO_SECRET_PATHS` knows how to seal.
 */
import { resolveTxt } from "node:dns/promises";
import { requireEnv } from "@oxagen/config/env";
import {
  assertPublicHttpUrl,
  fetchWithoutRedirects,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import type { schema } from "@oxagen/database";
import {
  isSealedSsoSecret,
  plaintextSsoSecretPaths,
  redactSsoConfig,
  resolveSsoKms,
  sealSsoConfig,
} from "@oxagen/database/sso-secrets";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  ssoCallbackPath,
  ssoSpMetadataPath,
  ssoVerificationRecordName,
  ssoVerificationRecordValue,
  type SsoGroupRole,
  type SsoMappableRole,
  type SsoProtocolName,
  type SsoProviderView,
} from "@oxagen/oxagen/contracts/org.sso.shared";

export type SsoProviderRow = typeof schema.ssoProviderTable.$inferSelect;
type Json = Record<string, unknown>;

const REFUSING = "Refusing to register SSO provider";

/** How long the discovery read may take before registration gives up. */
export const SSO_DISCOVERY_TIMEOUT_MS = 10_000;

/** The scopes every OIDC provider is asked for, before any extra ones. */
export const SSO_BASE_SCOPES = ["openid", "email", "profile"] as const;

// ---------------------------------------------------------------------------
// Seams. Tests swap the network and DNS reads; production uses the defaults.
// ---------------------------------------------------------------------------

export type SsoDiscoveryFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type SsoResolveTxt = (name: string) => Promise<string[][]>;

let discoveryFetchOverride: SsoDiscoveryFetch | null = null;
let resolveTxtOverride: SsoResolveTxt | null = null;

/** Replace the discovery fetch. Pass null to restore the default. */
export function setSsoDiscoveryFetchForTests(
  fn: SsoDiscoveryFetch | null,
): void {
  discoveryFetchOverride = fn;
}

/** Replace the DNS TXT lookup. Pass null to restore the default. */
export function setSsoResolveTxtForTests(fn: SsoResolveTxt | null): void {
  resolveTxtOverride = fn;
}

export function ssoResolveTxt(name: string): Promise<string[][]> {
  return (resolveTxtOverride ?? resolveTxt)(name);
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** BETTER_AUTH_URL without a trailing slash: the base every SSO URL hangs off. */
export function ssoAuthBaseUrl(): string {
  const { BETTER_AUTH_URL } = requireEnv(["BETTER_AUTH_URL"] as const);
  return BETTER_AUTH_URL.replace(/\/+$/, "");
}

/** The SAML SP entity id: the SP metadata URL, which is unique per provider. */
export function ssoSpEntityId(baseUrl: string, providerId: string): string {
  return `${baseUrl}${ssoSpMetadataPath(providerId)}`;
}

// ---------------------------------------------------------------------------
// OIDC discovery
// ---------------------------------------------------------------------------

export interface SsoOidcDiscovery {
  /** The issuer exactly as the discovery document states it. */
  issuer: string;
  discoveryEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication: "client_secret_basic" | "client_secret_post";
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function assertPublic(capability: string, url: string, what: string): void {
  try {
    assertPublicHttpUrl(url, { refusing: REFUSING, requireTls: true });
  } catch (err) {
    if (!(err instanceof UnsafeOutboundUrlError)) throw err;
    throw new CapabilityError(
      capability,
      "invalid_input",
      `${what}: ${err.message}`,
    );
  }
}

function invalid(capability: string, message: string): CapabilityError {
  return new CapabilityError(capability, "invalid_input", message);
}

/**
 * Read the issuer's discovery document and return the endpoints sign-in
 * needs, so the plugin never has to discover them at sign-in time.
 *
 * The issuer and every endpoint the document names must be public https URLs:
 * this process fetches the token and JWKS endpoints later, so an endpoint on
 * a private address is refused here, not at the first sign-in. The request
 * does not follow redirects, because a redirect target is a URL nobody
 * checked. The document's `issuer` must match the one entered, ignoring a
 * trailing slash; the stored issuer is the document's spelling, because that
 * is what the IdP puts in the ID token's `iss` claim.
 */
export async function discoverOidc(
  capability: string,
  issuer: string,
): Promise<SsoOidcDiscovery> {
  assertPublic(capability, issuer, "The issuer URL is not allowed");
  const discoveryEndpoint = `${withoutTrailingSlash(issuer)}/.well-known/openid-configuration`;
  const doFetch =
    discoveryFetchOverride ?? fetchWithoutRedirects({ refusing: REFUSING });

  let response: Response;
  try {
    response = await doFetch(discoveryEndpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SSO_DISCOVERY_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw invalid(
      capability,
      `Could not read the discovery document at ${discoveryEndpoint}: ${reason}. Check the issuer URL.`,
    );
  }
  if (!response.ok) {
    throw invalid(
      capability,
      `The discovery document at ${discoveryEndpoint} returned HTTP ${response.status}. Check the issuer URL.`,
    );
  }

  let doc: Json;
  try {
    const parsed: unknown = await response.json();
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("not a JSON object");
    }
    doc = parsed as Json;
  } catch {
    throw invalid(
      capability,
      `The discovery document at ${discoveryEndpoint} is not valid JSON.`,
    );
  }

  const docIssuer = doc["issuer"];
  if (
    typeof docIssuer !== "string" ||
    withoutTrailingSlash(docIssuer) !== withoutTrailingSlash(issuer)
  ) {
    throw invalid(
      capability,
      `The discovery document names the issuer ${JSON.stringify(docIssuer ?? null)}, not ${issuer}. Enter the issuer exactly as the identity provider publishes it.`,
    );
  }

  const endpoint = (key: string, required: boolean): string | undefined => {
    const value = doc[key];
    if (value === undefined || value === null) {
      if (required) {
        throw invalid(
          capability,
          `The discovery document at ${discoveryEndpoint} has no ${key}.`,
        );
      }
      return undefined;
    }
    if (typeof value !== "string") {
      throw invalid(
        capability,
        `The discovery document's ${key} is not a URL.`,
      );
    }
    assertPublic(
      capability,
      value,
      `The discovery document's ${key} is not allowed`,
    );
    return value;
  };

  const authorizationEndpoint = endpoint("authorization_endpoint", true)!;
  const tokenEndpoint = endpoint("token_endpoint", true)!;
  const jwksEndpoint = endpoint("jwks_uri", true)!;
  const userInfoEndpoint = endpoint("userinfo_endpoint", false);

  // Basic is the OIDC default and what a provider that lists nothing
  // supports. Post is chosen only when the provider says it does not do basic.
  const methods = doc["token_endpoint_auth_methods_supported"];
  const tokenEndpointAuthentication =
    !Array.isArray(methods) || methods.includes("client_secret_basic")
      ? "client_secret_basic"
      : "client_secret_post";

  return {
    issuer: docIssuer,
    discoveryEndpoint,
    authorizationEndpoint,
    tokenEndpoint,
    jwksEndpoint,
    ...(userInfoEndpoint ? { userInfoEndpoint } : {}),
    tokenEndpointAuthentication,
  };
}

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

/** openid, email and profile, then the extra scopes, each once. */
export function ssoScopes(extra: readonly string[] | undefined): string[] {
  return [...new Set([...SSO_BASE_SCOPES, ...(extra ?? [])])];
}

/**
 * The plugin's OIDCConfig. `clientSecret` is either the plaintext the admin
 * entered or the sealed token already stored; sealing skips a sealed value.
 *
 * `mapping.extraFields.groups` is required: it is the only way the IdP's
 * groups claim reaches the sign-in provisioner that applies the group-to-role
 * table.
 */
export function buildSsoOidcConfig(input: {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[] | undefined;
  discovery: SsoOidcDiscovery;
  groupsClaim: string;
}): Json {
  const d = input.discovery;
  return {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    discoveryEndpoint: d.discoveryEndpoint,
    authorizationEndpoint: d.authorizationEndpoint,
    tokenEndpoint: d.tokenEndpoint,
    jwksEndpoint: d.jwksEndpoint,
    ...(d.userInfoEndpoint ? { userInfoEndpoint: d.userInfoEndpoint } : {}),
    tokenEndpointAuthentication: d.tokenEndpointAuthentication,
    scopes: ssoScopes(input.scopes),
    pkce: true,
    mapping: {
      id: "sub",
      email: "email",
      emailVerified: "email_verified",
      name: "name",
      image: "picture",
      extraFields: { groups: input.groupsClaim },
    },
  };
}

/**
 * The plugin's SAMLConfig. `spPrivateKey` is plaintext, the sealed token
 * already stored, or absent; with a key the SP signs its AuthnRequests.
 */
export function buildSsoSamlConfig(input: {
  issuer: string;
  entryPoint: string;
  cert: string;
  spPrivateKey: string | undefined;
  spEntityId: string;
  groupsClaim: string;
}): Json {
  const key = input.spPrivateKey;
  return {
    entryPoint: input.entryPoint,
    cert: input.cert,
    audience: input.spEntityId,
    spMetadata: {
      entityID: input.spEntityId,
      ...(key ? { privateKey: key } : {}),
    },
    idpMetadata: {
      entityID: input.issuer,
      cert: input.cert,
      singleSignOnService: [
        {
          Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
          Location: input.entryPoint,
        },
      ],
    },
    wantAssertionsSigned: true,
    authnRequestsSigned: Boolean(key),
    ...(key ? { privateKey: key } : {}),
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    mapping: {
      id: "nameID",
      email: "email",
      name: "displayName",
      firstName: "givenName",
      lastName: "surname",
      extraFields: { groups: input.groupsClaim },
    },
  };
}

/** Parse a stored config column. A missing or unreadable column is `{}`. */
export function parseStoredSsoConfig(stored: string | null): Json {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Json)
      : {};
  } catch {
    return {};
  }
}

/** Point a stored config's groups mapping at a new claim. Secrets stay sealed. */
export function withSsoGroupsClaim(config: Json, groupsClaim: string): Json {
  const mapping =
    config["mapping"] !== null && typeof config["mapping"] === "object"
      ? (config["mapping"] as Json)
      : {};
  const extraFields =
    mapping["extraFields"] !== null &&
    typeof mapping["extraFields"] === "object"
      ? (mapping["extraFields"] as Json)
      : {};
  return {
    ...config,
    mapping: {
      ...mapping,
      extraFields: { ...extraFields, groups: groupsClaim },
    },
  };
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * Refuse before anything else runs when no KMS is configured. An SSO secret
 * is never stored in plaintext, not even transiently.
 */
export function requireSsoKms(): NonNullable<ReturnType<typeof resolveSsoKms>> {
  const kms = resolveSsoKms();
  if (!kms) {
    throw new Error(
      "Cannot store an SSO provider: AUTH_TOKEN_ENCRYPTION_KEY is unset, so " +
        "its secrets cannot be envelope-encrypted. Refusing to store them in " +
        "plaintext.",
    );
  }
  return kms;
}

/**
 * Refuse a secret the caller sent that is already a sealed token. The sealer
 * keeps a sealed value as it is and the sign-in path opens it, so accepting
 * one from input would let an admin make the server decrypt a secret sealed
 * for another organisation and send it to their own IdP endpoint. The
 * contract refuses these too; this is the handler's backstop. A handler
 * reusing the token it already stores never calls this.
 */
export function refuseSealedSsoInput(
  capability: string,
  field: string,
  value: string | undefined,
): void {
  if (value !== undefined && isSealedSsoSecret(value)) {
    throw new CapabilityError(
      capability,
      "invalid_input",
      `${field} must be the secret itself, not a stored value.`,
    );
  }
}

/**
 * Seal every secret in `config` and return the JSON text to store. The
 * plaintext check after sealing is defence in depth: a secret path the
 * sealer missed fails the write rather than reaching a column.
 */
export async function sealSsoConfigOrRefuse(
  protocol: SsoProtocolName,
  config: Json,
  kms: NonNullable<ReturnType<typeof resolveSsoKms>>,
): Promise<string> {
  const text = await sealSsoConfig(protocol, config, kms);
  const leaked = plaintextSsoSecretPaths(protocol, JSON.parse(text) as Json);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to store an SSO provider: ${leaked.join(", ")} would be stored in plaintext.`,
    );
  }
  return text;
}

/**
 * Re-serialize a stored config whose secrets are already sealed, for a change
 * that touches no secret (a new groups claim). Needs no KMS, and still refuses
 * to write a config that holds a plaintext secret.
 */
export function serializeSealedSsoConfig(
  protocol: SsoProtocolName,
  config: Json,
): string {
  const leaked = plaintextSsoSecretPaths(protocol, config);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to store an SSO provider: ${leaked.join(", ")} would be stored in plaintext.`,
    );
  }
  return JSON.stringify(config);
}

/**
 * The discovery result a stored OIDC config already holds, or null when a
 * field is missing and discovery has to run again.
 */
export function storedSsoOidcDiscovery(
  config: Json,
  issuer: string,
): SsoOidcDiscovery | null {
  const str = (key: string): string | undefined =>
    typeof config[key] === "string" ? (config[key] as string) : undefined;
  const discoveryEndpoint = str("discoveryEndpoint");
  const authorizationEndpoint = str("authorizationEndpoint");
  const tokenEndpoint = str("tokenEndpoint");
  const jwksEndpoint = str("jwksEndpoint");
  const auth = str("tokenEndpointAuthentication");
  if (
    !discoveryEndpoint ||
    !authorizationEndpoint ||
    !tokenEndpoint ||
    !jwksEndpoint ||
    (auth !== "client_secret_basic" && auth !== "client_secret_post")
  ) {
    return null;
  }
  const userInfoEndpoint = str("userInfoEndpoint");
  return {
    issuer,
    discoveryEndpoint,
    authorizationEndpoint,
    tokenEndpoint,
    jwksEndpoint,
    ...(userInfoEndpoint ? { userInfoEndpoint } : {}),
    tokenEndpointAuthentication: auth,
  };
}

/** Whether two issuer URLs name the same issuer, ignoring a trailing slash. */
export function sameSsoIssuer(a: string, b: string): boolean {
  return withoutTrailingSlash(a) === withoutTrailingSlash(b);
}

// ---------------------------------------------------------------------------
// The provider view
// ---------------------------------------------------------------------------

export interface SsoGroupRoleRow {
  providerId: string;
  idpGroup: string;
  role: string;
}

/** Rows to the wire shape, keeping only roles the contract admits. */
export function toSsoGroupRoles(
  rows: readonly SsoGroupRoleRow[],
  providerId: string,
): SsoGroupRole[] {
  return rows
    .filter((r) => r.providerId === providerId)
    .map((r) => ({ group: r.idpGroup, role: r.role as SsoMappableRole }));
}

/**
 * A provider as a read returns it. The stored config goes through
 * `redactSsoConfig`, so each secret becomes a boolean before anything is
 * read from it, and no sealed or plain secret can reach the view.
 */
export function toSsoProviderView(
  row: SsoProviderRow,
  groupRoles: readonly SsoGroupRole[],
  baseUrl: string,
): SsoProviderView {
  const protocol = row.protocol as SsoProtocolName;
  const stored = parseStoredSsoConfig(
    protocol === "oidc" ? row.oidcConfig : row.samlConfig,
  );
  const redacted = redactSsoConfig(protocol, stored);
  const spMetadata =
    redacted["spMetadata"] !== null &&
    typeof redacted["spMetadata"] === "object"
      ? (redacted["spMetadata"] as Json)
      : {};
  const scopes = Array.isArray(redacted["scopes"])
    ? (redacted["scopes"] as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];

  return {
    providerId: row.providerId,
    displayName: row.displayName,
    protocol,
    domain: row.domain,
    domainVerified: row.domainVerified,
    issuer: row.issuer,
    groupsClaim: row.groupsClaim,
    domainVerification: {
      recordName: ssoVerificationRecordName(row.domain),
      recordValue: ssoVerificationRecordValue(row.domainVerificationToken),
    },
    callbackUrl: `${baseUrl}${ssoCallbackPath(protocol, row.providerId)}`,
    spMetadataUrl:
      protocol === "saml" ? ssoSpEntityId(baseUrl, row.providerId) : null,
    oidc:
      protocol === "oidc"
        ? {
            clientId: String(redacted["clientId"] ?? ""),
            clientSecretSet: redacted["clientSecret"] === true,
            scopes,
          }
        : null,
    saml:
      protocol === "saml"
        ? {
            entryPoint: String(redacted["entryPoint"] ?? ""),
            spPrivateKeySet:
              redacted["privateKey"] === true ||
              spMetadata["privateKey"] === true,
          }
        : null,
    groupRoles: [...groupRoles],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
