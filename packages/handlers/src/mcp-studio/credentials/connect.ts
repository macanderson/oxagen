// connect.ts: an operator connects an account to an operator-oauth server, and
// disconnects it (mcp-studio-spec, Authentication).
//
// The operator follows the connect link the credential source returned. The
// link and the callback sit on the app's origin, where the session cookie is,
// and the app proxies them to the API (see mcpStudioAppOrigin). The API finds the server in the workspace's published steering version,
// discovers its authorization server, and sends the operator there with PKCE
// and a one-time state. The callback trades the code for tokens and stores
// them sealed in mcp.operator_tokens, one row per operator, server, and
// environment. The OAuth client is the one the environment names as
// `oxagen:credential/<name>`, or one Oxagen registers with the authorization
// server (RFC 7591) when the environment names none.
//
// No token or client secret appears in an error message, a return value, or
// the connect state. A registered client's secret travels sealed.
import { randomBytes } from "node:crypto";
import { UnsafeOutboundUrlError } from "@oxagen/config/public-url";
import type { CredentialSource, ManifestServer } from "@oxagen/mcp-studio";
import { parseCredentialRef } from "@oxagen/oxagen/steering-repo/names";
import {
  decryptCredentialSecrets,
  encryptCredentialSecrets,
  resolveCredentialKms,
  type ResolvedKms,
} from "@oxagen/plugins";
import {
  authorizationCodeGrant,
  authorizationUrl,
  discoverAuthorizationServer,
  type FetchLike,
  type OAuthClient,
  OAuthRefusedError,
  OAuthUnavailableError,
  pkcePair,
  registerClient,
} from "./oauth";
import { publishedServers } from "./published-manifest";
import { revokeAtServer, revokeOperatorToken } from "./revoke";
import { createCredentialSource } from "./source";
import {
  type ConnectState,
  type ConnectStateStore,
  type CredentialScope,
  type CredentialStore,
  postgresConnectStateStore,
  postgresCredentialStore,
} from "./store";

/** How long an operator has to finish the authorization server's sign-in. */
export const CONNECT_STATE_TTL_MS = 10 * 60_000;

export type ConnectErrorStatus = 400 | 403 | 404 | 409 | 502 | 503;

/** Why a connect or a callback failed. The message names no secret. */
export class ConnectError extends Error {
  override readonly name = "ConnectError";
  constructor(
    readonly status: ConnectErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectDeps {
  /** The credential rows of one workspace. */
  store: (scope: CredentialScope) => CredentialStore;
  states: ConnectStateStore;
  /** The servers the workspace has published, by name. */
  servers: (scope: CredentialScope) => Promise<Map<string, ManifestServer>>;
  fetch?: FetchLike;
  now?: () => Date;
  /** The vault key. Defaults to resolveCredentialKms(). */
  kms?: ResolvedKms | null;
  timeoutMs?: number;
}

/** The Postgres stores and the published manifest. */
export function defaultConnectDeps(): ConnectDeps {
  return {
    store: postgresCredentialStore,
    states: postgresConnectStateStore,
    servers: publishedServers,
  };
}

export interface ConnectTarget extends CredentialScope {
  userId: string;
  server: string;
  environment: string;
}

interface Runtime {
  kms: ResolvedKms;
  fetch: FetchLike;
  now: () => Date;
  timeoutMs: number | undefined;
}

function runtime(deps: ConnectDeps): Runtime {
  const kms = deps.kms === undefined ? resolveCredentialKms() : deps.kms;
  if (kms === null) {
    throw new ConnectError(
      503,
      "vault",
      "The credential vault has no key, so Oxagen cannot store the token. Set AUTH_TOKEN_ENCRYPTION_KEY on the API.",
    );
  }
  return {
    kms,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? (() => new Date()),
    timeoutMs: deps.timeoutMs,
  };
}

/** Map an error from an authorization server request to a ConnectError. */
function providerError(error: unknown, label: string): never {
  if (error instanceof OAuthRefusedError) {
    throw new ConnectError(400, "refused", `${error.message} Check the ${label} server's OAuth settings, then connect again.`);
  }
  if (error instanceof OAuthUnavailableError || error instanceof UnsafeOutboundUrlError) {
    throw new ConnectError(502, "provider", `${error.message} Connect again once ${label}'s authorization server answers.`);
  }
  throw error;
}

async function openClientSecret(sealed: string, keyId: string, kms: ResolvedKms): Promise<string | null> {
  const secrets = await decryptCredentialSecrets(
    { tokenKmsKeyId: keyId, oauthClientSecretEnc: Buffer.from(sealed, "base64") },
    kms,
  );
  return secrets.oauthClientSecret;
}

/**
 * Start a connect: answer the authorization URL to send the operator to, and
 * the state the callback must carry back. The route binds the state to the
 * operator's browser with a cookie.
 */
export async function beginConnect(
  input: ConnectTarget & { redirectUri: string },
  deps: ConnectDeps,
): Promise<{ authorizationUrl: string; state: string }> {
  const rt = runtime(deps);
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId };
  const server = (await deps.servers(scope)).get(input.server);
  if (server === undefined) {
    throw new ConnectError(404, "not_published", `No published server named ${input.server} exists in this workspace.`);
  }
  const environment = server.environments[input.environment];
  if (environment === undefined) {
    throw new ConnectError(
      404,
      "not_published",
      `The ${server.label} server has no ${input.environment} environment in the published steering version.`,
    );
  }
  const auth = server.auth;
  if (auth === null || auth.mode !== "operator-oauth") {
    throw new ConnectError(
      400,
      "not_operator_oauth",
      `The ${server.label} server does not sign in as each operator, so there is no account to connect.`,
    );
  }
  if (auth.apply.type !== "oauth2" && auth.apply.type !== "openIdConnect") {
    throw new ConnectError(
      400,
      "not_operator_oauth",
      `The ${server.label} server's scheme is ${auth.apply.type}. An operator connects only through oauth2 or openIdConnect.`,
    );
  }
  const store = deps.store(scope);
  if (!(await store.isMember(input.userId))) {
    throw new ConnectError(403, "not_member", "You are not a member of this workspace.");
  }

  const options = { fetch: rt.fetch, signal: new AbortController().signal, timeoutMs: rt.timeoutMs };
  const scopes = auth.apply.scopes ?? [];
  const found = await discoverAuthorizationServer({ apply: auth.apply, serverUrl: environment.url }, options).catch(
    (error: unknown) => providerError(error, server.label),
  );
  if (found.authorizationEndpoint === null) {
    throw new ConnectError(
      502,
      "provider",
      `The ${server.label} authorization server names no authorization endpoint, so an operator cannot sign in to it.`,
    );
  }

  let client: OAuthClient;
  let credentialId: string | null = null;
  let clientSecretSealed: string | null = null;
  let kmsKeyId: string | null = null;
  if (environment.credential !== undefined) {
    const name = parseCredentialRef(environment.credential);
    const named = name === null ? null : await store.credentialByName(name);
    if (named === null || named.oauthClientId === null) {
      throw new ConnectError(
        409,
        "no_client",
        `The ${server.label} server's ${input.environment} environment names ${environment.credential}, and this workspace holds no OAuth client by that name. Add the client id and secret in Oxagen, then connect again.`,
      );
    }
    const secrets = await decryptCredentialSecrets(named, rt.kms);
    client = { clientId: named.oauthClientId, clientSecret: secrets.oauthClientSecret };
    credentialId = named.id;
  } else {
    if (found.registrationEndpoint === null) {
      throw new ConnectError(
        409,
        "no_client",
        `The ${server.label} authorization server does not register clients, and the ${input.environment} environment names no OAuth client. Add credential = "oxagen:credential/<name>" with the client id and secret, then connect again.`,
      );
    }
    client = await registerClient(
      { registrationEndpoint: found.registrationEndpoint, redirectUri: input.redirectUri, scopes },
      options,
    ).catch((error: unknown) => providerError(error, server.label));
    if (client.clientSecret !== null) {
      const sealed = await encryptCredentialSecrets({ oauthClientSecret: client.clientSecret }, rt.kms);
      clientSecretSealed = sealed.oauthClientSecretEnc?.toString("base64") ?? null;
      kmsKeyId = sealed.tokenKmsKeyId;
    }
  }

  const pkce = pkcePair();
  const state = randomBytes(32).toString("base64url");
  const data: ConnectState = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    server: input.server,
    environment: input.environment,
    label: server.label,
    credentialId,
    clientId: client.clientId,
    clientSecretSealed,
    kmsKeyId,
    tokenEndpoint: found.tokenEndpoint,
    refreshEndpoint: found.refreshEndpoint,
    revocationEndpoint: found.revocationEndpoint,
    resource: found.resource,
    redirectUri: input.redirectUri,
    codeVerifier: pkce.verifier,
    scopes,
  };
  await deps.states.save(state, data, new Date(rt.now().getTime() + CONNECT_STATE_TTL_MS));
  return {
    authorizationUrl: authorizationUrl({
      authorizationEndpoint: found.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: input.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes,
      resource: found.resource,
    }),
    state,
  };
}

/**
 * Finish a connect: trade the code for tokens and store them for the operator
 * who started it. Answers who connected what, for the page the operator sees.
 */
export async function finishConnect(
  input: {
    state: string;
    code: string;
    /**
     * The signed-in caller of the callback. When given, the state must name
     * the same operator and workspace, so a token is never stored for a
     * person other than the one whose session finished the sign-in.
     */
    caller?: { orgId: string; workspaceId: string; userId: string };
  },
  deps: ConnectDeps,
): Promise<ConnectTarget & { label: string }> {
  const rt = runtime(deps);
  const data = await deps.states.take(input.state, rt.now());
  if (data === null) {
    throw new ConnectError(400, "state", "This connect link expired or was already used. Start again from Oxagen.");
  }
  const caller = input.caller;
  if (
    caller !== undefined &&
    (caller.userId !== data.userId || caller.orgId !== data.orgId || caller.workspaceId !== data.workspaceId)
  ) {
    throw new ConnectError(
      403,
      "not_operator",
      "Another Oxagen account started this connect, so nothing was connected. Start again from Oxagen.",
    );
  }
  const scope = { orgId: data.orgId, workspaceId: data.workspaceId };
  const store = deps.store(scope);

  let clientSecret: string | null = null;
  if (data.clientSecretSealed !== null && data.kmsKeyId !== null) {
    clientSecret = await openClientSecret(data.clientSecretSealed, data.kmsKeyId, rt.kms);
  } else if (data.credentialId !== null) {
    const named = await store.credentialById(data.credentialId);
    if (named === null) {
      throw new ConnectError(
        409,
        "no_client",
        `The OAuth client for the ${data.label} server was removed while you signed in. Add it again in Oxagen, then connect again.`,
      );
    }
    clientSecret = (await decryptCredentialSecrets(named, rt.kms)).oauthClientSecret;
  }
  const client: OAuthClient = { clientId: data.clientId, clientSecret };
  const options = { fetch: rt.fetch, signal: new AbortController().signal, timeoutMs: rt.timeoutMs };

  const token = await authorizationCodeGrant(
    {
      tokenEndpoint: data.tokenEndpoint,
      client,
      code: input.code,
      redirectUri: data.redirectUri,
      codeVerifier: data.codeVerifier,
      resource: data.resource,
    },
    { ...options, now: rt.now() },
  ).catch((error: unknown) => providerError(error, data.label));

  const sealed = await encryptCredentialSecrets(
    {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      // A named client keeps its secret on its own row. A registered client's
      // secret lives with the token, because nothing else holds it.
      oauthClientSecret: data.clientSecretSealed === null ? null : clientSecret,
    },
    rt.kms,
  );
  if (sealed.accessTokenEnc === null) {
    throw new ConnectError(502, "provider", `The ${data.label} authorization server returned an empty access token.`);
  }

  const key = { userId: data.userId, server: data.server, environment: data.environment };
  const previous = await store.operatorToken(key);
  await store.saveOperatorToken({
    ...key,
    credentialId: data.credentialId,
    clientId: data.clientId,
    clientSecretEnc: sealed.oauthClientSecretEnc,
    // The row's endpoint is where refreshes go.
    tokenEndpoint: data.refreshEndpoint,
    revocationEndpoint: data.revocationEndpoint,
    accessTokenEnc: sealed.accessTokenEnc,
    refreshTokenEnc: sealed.refreshTokenEnc,
    tokenKmsKeyId: sealed.tokenKmsKeyId,
    scopes: token.scopes ?? data.scopes,
    expiresAt: token.expiresAt,
    lastRefreshedAt: rt.now(),
  });
  if (previous !== null && previous.clientId !== data.clientId) {
    // The new row replaced a grant made through another client. Nothing holds
    // that grant's tokens now, so ask the server to end it. The same client's
    // old grant is left alone: revoking it can end the new one at servers
    // that revoke per client and person.
    await revokeAtServer(previous, { store, kms: rt.kms, fetch: rt.fetch, timeoutMs: rt.timeoutMs }).catch(
      () => false,
    );
  }
  return { ...scope, ...key, label: data.label };
}

/**
 * Disconnect: revoke the operator's token at the authorization server and
 * delete it. Answers false when the operator had no token for the server.
 */
export async function disconnect(input: ConnectTarget, deps: ConnectDeps): Promise<boolean> {
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId };
  const store = deps.store(scope);
  const row = await store.operatorToken({
    userId: input.userId,
    server: input.server,
    environment: input.environment,
  });
  if (row === null) return false;
  await revokeOperatorToken(row, {
    store,
    kms: deps.kms,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
  });
  return true;
}

const DEFAULT_APP_ORIGIN = "https://app.oxagen.sh";

const APP_ORIGIN_SOURCES = ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const;

/**
 * The origin of the web app an operator signs in to. The connect link and the
 * OAuth callback both live there.
 *
 * Better Auth sets its session cookie with no domain, so the cookie belongs to
 * the app host alone. A browser sends none of it to the API host, and a connect
 * link there answered 401 to an operator who was signed in. The app proxies
 * `/api/v1/*` to the API with the cookie attached (`apps/app/next.config.ts`),
 * so a link on the app origin reaches the same route with the session.
 *
 * `APP_URL` comes first because the env registry sets it on the api and mcp
 * services. `NEXT_PUBLIC_APP_URL` is the app's own variable. A value that does
 * not parse as a URL is skipped, and the answer is the origin alone.
 */
export function mcpStudioAppOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  for (const name of APP_ORIGIN_SOURCES) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      return new URL(raw).origin;
    } catch {
      // Not a URL. Try the next source.
    }
  }
  return DEFAULT_APP_ORIGIN;
}

/**
 * A URL on the workspace's operator OAuth routes, as the browser reaches them
 * through the app's `/api/v1/*` proxy. `connect` is the link an operator
 * follows. `callback` is the redirect URI the authorization server sends the
 * operator back to, so the state cookie the connect set comes back with it.
 */
export function mcpStudioOauthUrl(
  input: { appBaseUrl: string; orgSlug: string; workspaceSlug: string },
  leaf: "connect" | "callback",
): string {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  return `${base}${mcpStudioOauthPath(input)}/${leaf}`;
}

/** The browser-facing path of a workspace's operator OAuth routes. */
export function mcpStudioOauthPath(input: { orgSlug: string; workspaceSlug: string }): string {
  return `/api/v1/${encodeURIComponent(input.orgSlug)}/${encodeURIComponent(input.workspaceSlug)}/mcp-studio/oauth`;
}

/** The link an operator follows to connect an account, on the app's origin. */
export function mcpStudioConnectLink(input: {
  appBaseUrl: string;
  orgSlug: string;
  workspaceSlug: string;
  server: string;
  environment: string;
}): string {
  const query = new URLSearchParams({ server: input.server, environment: input.environment });
  return `${mcpStudioOauthUrl(input, "connect")}?${query.toString()}`;
}

/**
 * The CredentialSource for one workspace's runs: its credential rows, its
 * published servers, and connect links on the app's origin. Build one per run,
 * so the servers match the steering version the run was planned on.
 */
export async function workspaceCredentialSource(
  input: CredentialScope & {
    orgSlug: string;
    workspaceSlug: string;
    /** The app origin the link is built on. Defaults to `mcpStudioAppOrigin()`. */
    appBaseUrl?: string;
  },
  deps: Pick<ConnectDeps, "fetch" | "now" | "kms" | "timeoutMs"> &
    Partial<Pick<ConnectDeps, "store" | "servers">> = {},
): Promise<CredentialSource> {
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId };
  const servers = await (deps.servers ?? publishedServers)(scope);
  const appBaseUrl = input.appBaseUrl ?? mcpStudioAppOrigin();
  return createCredentialSource({
    store: (deps.store ?? postgresCredentialStore)(scope),
    server: (name) => servers.get(name),
    connectUrl: ({ server, environment }) =>
      mcpStudioConnectLink({
        appBaseUrl,
        orgSlug: input.orgSlug,
        workspaceSlug: input.workspaceSlug,
        server,
        environment,
      }),
    fetch: deps.fetch,
    now: deps.now,
    kms: deps.kms,
    timeoutMs: deps.timeoutMs,
  });
}
