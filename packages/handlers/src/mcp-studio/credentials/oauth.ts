// oauth.ts: the OAuth 2.0 requests behind MCP Studio credentials
// (mcp-studio-spec, Authentication): token grants, refresh, revocation,
// discovery, and dynamic client registration.
//
// Every request goes to a URL that a server folder or an authorization
// server's metadata named. So each one passes the public-URL guard, refuses a
// redirect, and stops at a deadline. A token or a client secret travels in
// the request body or the Authorization header. No error message or log line
// quotes one.
import { createHash, randomBytes } from "node:crypto";
import {
  assertPublicHttpUrl,
  redactUrlCredentials,
} from "@oxagen/config/public-url";
import type { SecurityScheme } from "@oxagen/mcp-studio";
import { z } from "zod";

/** How long one request to an authorization server may take. */
export const OAUTH_TIMEOUT_MS = 10_000;

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface OAuthRequestOptions {
  fetch: FetchLike;
  signal: AbortSignal;
  timeoutMs?: number;
}

/** The OAuth client a request authenticates as. */
export interface OAuthClient {
  clientId: string;
  /** Null for a public client, which sends its id in the body instead. */
  clientSecret: string | null;
}

/** What a token endpoint returned. */
export interface TokenSet {
  accessToken: string;
  /** Null when the server issued none, or kept the old one on refresh. */
  refreshToken: string | null;
  /** Null when the server did not say when the token expires. */
  expiresAt: Date | null;
  /** Null when the server did not say, which means the scopes asked for. */
  scopes: string[] | null;
}

/**
 * The authorization server refused the request: invalid_grant,
 * invalid_client, and the rest of RFC 6749 section 5.2. A person has to act,
 * so a retry would get the same answer.
 */
export class OAuthRefusedError extends Error {
  override readonly name = "OAuthRefusedError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The authorization server could not answer: a network error, a timeout, a
 * 5xx, a 429, or a body that is not what OAuth defines. A later retry may
 * work.
 */
export class OAuthUnavailableError extends Error {
  override readonly name = "OAuthUnavailableError";
}

/** Where an authorization server takes each request. */
export interface AuthorizationServer {
  /** Null for a server that offers only client credentials. */
  authorizationEndpoint: string | null;
  /** Where the authorization code and client credentials grants go. */
  tokenEndpoint: string;
  /** Where refresh goes. OpenAPI's refreshUrl, or the token endpoint. */
  refreshEndpoint: string;
  revocationEndpoint: string | null;
  registrationEndpoint: string | null;
  /**
   * The protected resource (RFC 8707) to name in the authorization and token
   * requests. Set only when the server published RFC 9728 metadata, as an
   * MCP server does, because a server that does not know the parameter may
   * refuse it.
   */
  resource: string | null;
}

const REFUSING = "Refusing to call the OAuth server";

/** One request to an authorization server, with the guard, no redirects, and a deadline. */
async function send(
  url: string,
  init: RequestInit,
  options: OAuthRequestOptions,
): Promise<Response> {
  assertPublicHttpUrl(url, { refusing: REFUSING, requireTls: true });
  const deadline = AbortSignal.timeout(options.timeoutMs ?? OAUTH_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline]);
  let response: Response;
  try {
    response = await options.fetch(url, { ...init, redirect: "manual", signal });
  } catch (error) {
    // The caller's own abort ends the call, so it passes through unchanged.
    if (options.signal.aborted) throw options.signal.reason;
    const why = deadline.aborted
      ? `it did not answer within ${options.timeoutMs ?? OAUTH_TIMEOUT_MS} ms`
      : error instanceof Error
        ? error.message
        : "the request failed";
    throw new OAuthUnavailableError(
      `The OAuth server at ${origin(url)} could not be reached: ${why}.`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OAuthRefusedError(
      "redirect",
      `The OAuth server at ${origin(url)} answered ${response.status} with a redirect. Oxagen does not follow redirects, so name the final URL.`,
    );
  }
  return response;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return redactUrlCredentials(url);
  }
}

const oauthErrorSchema = z
  .object({ error: z.string().min(1), error_description: z.string().optional() })
  .passthrough();

/** Read an error answer. A 4xx other than 408 and 429 is a refusal. */
async function failure(url: string, response: Response): Promise<Error> {
  const status = response.status;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = oauthErrorSchema.safeParse(body);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    const code = parsed.success ? parsed.data.error : `http_${status}`;
    return new OAuthRefusedError(
      code,
      `The OAuth server at ${origin(url)} refused the request (${code}).`,
    );
  }
  return new OAuthUnavailableError(
    `The OAuth server at ${origin(url)} answered ${status}.`,
  );
}

const expiresInSchema = z.union([
  z.number().nonnegative(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: expiresInSchema.optional(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

/** RFC 6749 section 2.3.1: each half is form-encoded before base64. */
function basicAuthorization(client: OAuthClient & { clientSecret: string }): string {
  const pair = `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

type ClientAuth = "basic" | "post";

async function postForm(
  url: string,
  params: Record<string, string>,
  client: OAuthClient,
  auth: ClientAuth,
  options: OAuthRequestOptions,
): Promise<Response> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.clientSecret === null) {
    body.set("client_id", client.clientId);
  } else if (auth === "basic") {
    headers.authorization = basicAuthorization({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    });
  } else {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
  }
  return send(url, { method: "POST", headers, body: body.toString() }, options);
}

/**
 * Post a token request. The client authenticates with HTTP Basic first. A
 * server that answers invalid_client to that gets the secret in the body
 * once, because RFC 6749 lets a server support either one.
 */
async function tokenRequest(
  url: string,
  params: Record<string, string>,
  client: OAuthClient,
  options: OAuthRequestOptions & { now: Date },
): Promise<TokenSet> {
  let response = await postForm(url, params, client, "basic", options);
  if (!response.ok && client.clientSecret !== null) {
    const error = await failure(url, response);
    if (!(error instanceof OAuthRefusedError) || error.code !== "invalid_client") {
      throw error;
    }
    response = await postForm(url, params, client, "post", options);
  }
  if (!response.ok) throw await failure(url, response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthUnavailableError(
      `The OAuth server at ${origin(url)} answered with a body that is not JSON.`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthUnavailableError(
      `The OAuth server at ${origin(url)} answered without an access token.`,
    );
  }
  const token = parsed.data;
  if (token.token_type !== undefined && token.token_type.toLowerCase() !== "bearer") {
    throw new OAuthRefusedError(
      "unsupported_token_type",
      `The OAuth server at ${origin(url)} issued a ${token.token_type} token. Oxagen sends bearer tokens only.`,
    );
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt:
      token.expires_in === undefined
        ? null
        : new Date(options.now.getTime() + token.expires_in * 1000),
    scopes:
      token.scope === undefined
        ? null
        : token.scope.split(" ").filter((scope) => scope.length > 0),
  };
}

/** RFC 6749 section 4.4: the client credentials grant. */
export function clientCredentialsGrant(
  input: { tokenEndpoint: string; client: OAuthClient; scopes: string[] },
  options: OAuthRequestOptions & { now: Date },
): Promise<TokenSet> {
  const params: Record<string, string> = { grant_type: "client_credentials" };
  if (input.scopes.length > 0) params.scope = input.scopes.join(" ");
  return tokenRequest(input.tokenEndpoint, params, input.client, options);
}

/** RFC 6749 section 6: trade a refresh token for a new access token. */
export function refreshGrant(
  input: { tokenEndpoint: string; client: OAuthClient; refreshToken: string },
  options: OAuthRequestOptions & { now: Date },
): Promise<TokenSet> {
  return tokenRequest(
    input.tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: input.refreshToken },
    input.client,
    options,
  );
}

/** RFC 6749 section 4.1.3 with RFC 7636: trade the authorization code for tokens. */
export function authorizationCodeGrant(
  input: {
    tokenEndpoint: string;
    client: OAuthClient;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string | null;
  },
  options: OAuthRequestOptions & { now: Date },
): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  };
  if (input.resource !== null) params.resource = input.resource;
  return tokenRequest(input.tokenEndpoint, params, input.client, options);
}

/**
 * RFC 7009: revoke a token. Answers true when the server accepted it. The
 * caller deletes its copy either way, so a failure here only means the
 * provider keeps a token nobody holds.
 */
export async function revokeToken(
  input: {
    revocationEndpoint: string;
    client: OAuthClient;
    token: string;
    hint: "access_token" | "refresh_token";
  },
  options: OAuthRequestOptions,
): Promise<boolean> {
  try {
    const response = await postForm(
      input.revocationEndpoint,
      { token: input.token, token_type_hint: input.hint },
      input.client,
      "basic",
      options,
    );
    return response.ok;
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    return false;
  }
}

/** An RFC 7636 verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The authorization request URL, with PKCE (RFC 7636) and state. */
export function authorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
  if (input.resource !== null) url.searchParams.set("resource", input.resource);
  return url.toString();
}

const serverMetadataSchema = z
  .object({
    issuer: z.string().optional(),
    authorization_endpoint: z.string().url().optional(),
    token_endpoint: z.string().url(),
    revocation_endpoint: z.string().url().optional(),
    registration_endpoint: z.string().url().optional(),
  })
  .passthrough();

const resourceMetadataSchema = z
  .object({
    resource: z.string().url().optional(),
    authorization_servers: z.array(z.string().url()).min(1),
  })
  .passthrough();

/** GET a metadata document. Answers null for a 404, so the caller tries the next place. */
async function getJson(
  url: string,
  options: OAuthRequestOptions,
): Promise<unknown> {
  const response = await send(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    options,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(url, response);
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    throw new OAuthUnavailableError(
      `The metadata at ${origin(url)} is not JSON.`,
    );
  }
}

/** RFC 8615 well-known URL: the suffix goes between the origin and the path. */
function wellKnown(base: string, suffix: string): string {
  const url = new URL(base);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
}

function fromMetadata(
  body: unknown,
  where: string,
  resource: string | null,
): AuthorizationServer {
  const parsed = serverMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthRefusedError(
      "invalid_metadata",
      `The authorization server metadata at ${origin(where)} names no token endpoint.`,
    );
  }
  const m = parsed.data;
  return {
    authorizationEndpoint: m.authorization_endpoint ?? null,
    tokenEndpoint: m.token_endpoint,
    refreshEndpoint: m.token_endpoint,
    revocationEndpoint: m.revocation_endpoint ?? null,
    registrationEndpoint: m.registration_endpoint ?? null,
    resource,
  };
}

/** RFC 8414 first, then OpenID Connect discovery, at one issuer. */
async function issuerMetadata(
  issuer: string,
  resource: string | null,
  options: OAuthRequestOptions,
): Promise<AuthorizationServer | null> {
  for (const suffix of ["oauth-authorization-server", "openid-configuration"]) {
    const url = wellKnown(issuer, suffix);
    const body = await getJson(url, options);
    if (body !== null) return fromMetadata(body, url, resource);
  }
  return null;
}

/**
 * Find the authorization server for a scheme, in this order:
 *
 * 1. The scheme's own URLs, which an OpenAPI oauth2 flow carries.
 * 2. The scheme's OpenID Connect discovery document.
 * 3. The server's RFC 9728 protected resource metadata, then that
 *    authorization server's RFC 8414 metadata. A remote MCP server publishes
 *    these, and its scheme names no URL.
 * 4. RFC 8414 metadata at the server's own origin, for a server that
 *    publishes no RFC 9728 document.
 */
export async function discoverAuthorizationServer(
  input: { apply: SecurityScheme; serverUrl: string | undefined },
  options: OAuthRequestOptions,
): Promise<AuthorizationServer> {
  const { apply } = input;
  if (apply.token_url !== undefined) {
    return {
      authorizationEndpoint: apply.authorization_url ?? null,
      tokenEndpoint: apply.token_url,
      refreshEndpoint: apply.refresh_url ?? apply.token_url,
      revocationEndpoint: null,
      registrationEndpoint: null,
      resource: null,
    };
  }
  if (apply.openid_connect_url !== undefined) {
    const body = await getJson(apply.openid_connect_url, options);
    if (body === null) {
      throw new OAuthRefusedError(
        "invalid_metadata",
        `The OpenID Connect document at ${origin(apply.openid_connect_url)} was not found.`,
      );
    }
    return fromMetadata(body, apply.openid_connect_url, null);
  }
  if (input.serverUrl === undefined) {
    throw new OAuthRefusedError(
      "invalid_metadata",
      "The server's scheme names no token URL, and the environment has no URL to discover one from.",
    );
  }
  const resourceDocument = await getJson(
    wellKnown(input.serverUrl, "oauth-protected-resource"),
    options,
  );
  if (resourceDocument !== null) {
    const parsed = resourceMetadataSchema.safeParse(resourceDocument);
    if (parsed.success) {
      const [issuer] = parsed.data.authorization_servers;
      const resource = parsed.data.resource ?? input.serverUrl;
      const found = issuer === undefined ? null : await issuerMetadata(issuer, resource, options);
      if (found !== null) return found;
    }
  }
  const found = await issuerMetadata(new URL(input.serverUrl).origin, null, options);
  if (found !== null) return found;
  throw new OAuthRefusedError(
    "invalid_metadata",
    `No OAuth metadata was found for ${origin(input.serverUrl)}.`,
  );
}

const registrationResponseSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1).optional(),
  })
  .passthrough();

/** RFC 7591: register Oxagen as a client of an authorization server that allows it. */
export async function registerClient(
  input: { registrationEndpoint: string; redirectUri: string; scopes: string[] },
  options: OAuthRequestOptions,
): Promise<OAuthClient> {
  const metadata: Record<string, unknown> = {
    client_name: "Oxagen",
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  };
  if (input.scopes.length > 0) metadata.scope = input.scopes.join(" ");
  const response = await send(
    input.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(metadata),
    },
    options,
  );
  if (!response.ok) throw await failure(input.registrationEndpoint, response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = registrationResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthUnavailableError(
      `The registration endpoint at ${origin(input.registrationEndpoint)} answered without a client id.`,
    );
  }
  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret ?? null,
  };
}
