// source.ts: the CredentialSource the executor asks before each call
// (mcp-studio-spec, Authentication).
//
// A service server uses one credential for every run. The environment names
// it as `oxagen:credential/<name>`, and this source reads the mcp.credentials
// row by that name. An API key, a bearer token, and a basic pair come
// straight from the vault. An OAuth credential returns its cached access
// token, and the source refreshes it through the token endpoint once the
// token is within a minute of expiring. A credential with a client id and
// secret and no refresh token fetches a new token with client credentials.
//
// An operator-oauth server uses the token of the person who operates the
// run. The operator connects once through the connect route, which stores
// the token in mcp.operator_tokens. The source refreshes it the same way.
// When the operator has no token, or the authorization server refused the
// refresh, the call gets the spec's message and a link to connect.
//
// A secret leaves this module only inside the ResolvedCredential it returns.
// No error message names one, and nothing here logs.
import type {
  CredentialRequest,
  CredentialSource,
  ManifestServer,
  ResolvedCredential,
  SecurityScheme,
} from "@oxagen/mcp-studio";
import { parseCredentialRef } from "@oxagen/oxagen/steering-repo/names";
import {
  decryptCredentialSecrets,
  encryptCredentialSecrets,
  resolveCredentialKms,
  type ResolvedKms,
} from "@oxagen/plugins";
import {
  type AuthorizationServer,
  clientCredentialsGrant,
  discoverAuthorizationServer,
  type FetchLike,
  type OAuthClient,
  OAuthRefusedError,
  OAuthUnavailableError,
  refreshGrant,
  type TokenSet,
} from "./oauth";
import { revokeOperatorTokens } from "./revoke";
import type {
  CredentialStore,
  StoredCredential,
  StoredOperatorToken,
} from "./store";

/** Refresh a token this long before it expires. */
export const REFRESH_SKEW_MS = 60_000;

/** Why a credential could not be resolved. No message quotes a secret. */
export type CredentialErrorCode =
  /** The environment names no credential. */
  | "no_reference"
  /** No credential by that name exists in the workspace. */
  | "not_found"
  /** The credential was revoked. */
  | "revoked"
  /** The authorization server refused the refresh, so a person connects again. */
  | "needs_reauth"
  /** The credential holds nothing the scheme can use. */
  | "unusable"
  /** The scheme is one Oxagen does not send from the vault. */
  | "unsupported"
  /** An operator-oauth call names no operator. */
  | "no_operator"
  /** The vault key is not configured, so nothing can be decrypted. */
  | "vault";

export class CredentialError extends Error {
  override readonly name = "CredentialError";
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CredentialSourceDeps {
  /** The workspace's credential rows. */
  store: CredentialStore;
  /** The published server by name, for its label and its environments' URLs. */
  server(name: string): ManifestServer | undefined;
  /** The link an operator follows to connect an account. */
  connectUrl(input: { server: string; environment: string }): string;
  fetch?: FetchLike;
  now?: () => Date;
  /** The vault key. Defaults to resolveCredentialKms(). */
  kms?: ResolvedKms | null;
  refreshSkewMs?: number;
  timeoutMs?: number;
}

interface Secrets {
  accessToken: string | null;
  refreshToken: string | null;
  secret: string | null;
  oauthClientSecret: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve after `promise`, or reject when the caller's signal aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createCredentialSource(deps: CredentialSourceDeps): CredentialSource {
  const { store } = deps;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const skewMs = deps.refreshSkewMs ?? REFRESH_SKEW_MS;
  const kms = deps.kms === undefined ? resolveCredentialKms() : deps.kms;

  // One refresh per row at a time. Two calls that find the same token near
  // expiry share one request, so a server that rotates refresh tokens does
  // not see the old one twice. The shared request runs on its own deadline,
  // so one caller's abort does not fail the other.
  const inflight = new Map<string, Promise<ResolvedCredential>>();
  const once = (
    key: string,
    signal: AbortSignal,
    run: (shared: AbortSignal) => Promise<ResolvedCredential>,
  ): Promise<ResolvedCredential> => {
    let pending = inflight.get(key);
    if (pending === undefined) {
      pending = run(new AbortController().signal).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return untilAborted(pending, signal);
  };

  const discovered = new Map<string, Promise<AuthorizationServer>>();
  const authorizationServer = (
    request: CredentialRequest,
    signal: AbortSignal,
  ): Promise<AuthorizationServer> => {
    const key = `${request.server}/${request.environment}`;
    let found = discovered.get(key);
    if (found === undefined) {
      const url = deps.server(request.server)?.environments[request.environment]?.url;
      found = discoverAuthorizationServer(
        { apply: request.auth.apply, serverUrl: url },
        { fetch: fetchImpl, signal, timeoutMs: deps.timeoutMs },
      );
      found.catch(() => discovered.delete(key));
      discovered.set(key, found);
    }
    return found;
  };

  const requireKms = (): ResolvedKms => {
    if (kms === null) {
      throw new CredentialError(
        "vault",
        "The credential vault has no key, so no credential can be read. Set AUTH_TOKEN_ENCRYPTION_KEY on the API.",
      );
    }
    return kms;
  };

  const open = async (sealed: Parameters<typeof decryptCredentialSecrets>[0]): Promise<Secrets> => {
    if (sealed.tokenKmsKeyId === null) {
      return { accessToken: null, refreshToken: null, secret: null, oauthClientSecret: null };
    }
    return decryptCredentialSecrets(sealed, requireKms());
  };

  const fresh = (expiresAt: Date | null): boolean =>
    expiresAt === null || expiresAt.getTime() - now().getTime() > skewMs;
  const unexpired = (expiresAt: Date | null): boolean =>
    expiresAt === null || expiresAt.getTime() > now().getTime();

  const label = (server: string): string => deps.server(server)?.label ?? server;
  const missing = (request: CredentialRequest): ResolvedCredential => ({
    type: "missing",
    message: `Connect your ${label(request.server)} account in Oxagen, then retry.`,
    connect_url: deps.connectUrl({ server: request.server, environment: request.environment }),
  });

  // ── Service mode ─────────────────────────────────────────────────────────

  const serviceCredential = async (
    request: CredentialRequest,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> => {
    const { apply } = request.auth;
    if (request.reference === undefined) {
      throw new CredentialError(
        "no_reference",
        `The ${request.server} server's ${request.environment} environment names no credential. Add credential = "oxagen:credential/<name>" to its server.toml.`,
      );
    }
    const name = parseCredentialRef(request.reference);
    if (name === null) {
      throw new CredentialError(
        "no_reference",
        `The ${request.server} server's ${request.environment} environment names a credential that is not an oxagen:credential/<name> reference.`,
      );
    }
    const row = await store.credentialByName(name);
    if (row === null) {
      const held = relayHeld(request, name, apply);
      if (held !== null) return held;
      throw new CredentialError(
        "not_found",
        `No credential named ${name} exists in this workspace. Add it in Oxagen, then retry.`,
      );
    }
    if (row.status === "revoked") {
      throw new CredentialError("revoked", `The ${name} credential was revoked. Add a new one in Oxagen, then retry.`);
    }
    if (row.status === "needs_reauth") {
      throw new CredentialError(
        "needs_reauth",
        `The ${name} credential must be connected again. Reconnect it in Oxagen, then retry.`,
      );
    }

    if (row.authKind === "oauth") {
      if (apply.type === "http_basic" || apply.type === "api_key" || apply.type === "mutual_tls") {
        throw new CredentialError(
          "unusable",
          `The ${name} credential holds an OAuth token, and the ${request.server} server's scheme is ${apply.type}.`,
        );
      }
      return once(row.id, signal, (shared) => serviceToken(request, row, shared));
    }

    const secrets = await open(row);
    const value = secrets.secret ?? secrets.accessToken;
    if (value === null) {
      throw new CredentialError("unusable", `The ${name} credential holds no secret. Set its value in Oxagen, then retry.`);
    }
    switch (apply.type) {
      case "http_bearer":
      case "oauth2":
      case "openIdConnect":
        return { type: "bearer", token: value };
      case "api_key":
        return { type: "api_key", value };
      case "http_basic": {
        // A basic credential is stored as username:password, split at the
        // first colon, as RFC 7617 does: a username holds no colon.
        const colon = value.indexOf(":");
        if (colon < 1) {
          throw new CredentialError(
            "unusable",
            `The ${name} credential is not a username:password pair. Store it as username:password, then retry.`,
          );
        }
        return { type: "basic", username: value.slice(0, colon), password: value.slice(colon + 1) };
      }
      case "mutual_tls":
        throw new CredentialError(
          "unsupported",
          `The ${request.server} server uses mutual TLS. Oxagen sends no client certificate, so put the server behind a relay that holds it.`,
        );
    }
  };

  /**
   * On a relay network, a credential the vault does not hold is one the
   * customer keeps in the relay (Enterprise). The relay adds it after it
   * checks the envelope, so the executor sends none.
   */
  const relayHeld = (
    request: CredentialRequest,
    name: string,
    apply: SecurityScheme,
  ): ResolvedCredential | null => {
    const network = deps.server(request.server)?.environments[request.environment]?.network;
    if (network === undefined || !network.startsWith("relay:")) return null;
    switch (apply.type) {
      case "http_bearer":
      case "oauth2":
      case "openIdConnect":
        return { type: "relay", credential: { name, scheme: "bearer" } };
      case "http_basic":
        return { type: "relay", credential: { name, scheme: "basic" } };
      case "api_key":
        if (apply.in === "header" && apply.name !== undefined) {
          return { type: "relay", credential: { name, scheme: "header", header: apply.name } };
        }
        throw new CredentialError(
          "unsupported",
          `A relay adds a credential only in a header, and the ${request.server} server's API key goes in the ${apply.in ?? "request"}.`,
        );
      case "mutual_tls":
        throw new CredentialError(
          "unsupported",
          `The ${request.server} server uses mutual TLS, and a relay credential has no client certificate scheme yet.`,
        );
    }
  };

  const serviceToken = async (
    request: CredentialRequest,
    row: StoredCredential,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> => {
    const secrets = await open(row);
    if (secrets.accessToken !== null && fresh(row.expiresAt)) {
      return { type: "bearer", token: secrets.accessToken };
    }
    const client: OAuthClient | null =
      row.oauthClientId === null
        ? null
        : { clientId: row.oauthClientId, clientSecret: secrets.oauthClientSecret };
    const reconnect = async (): Promise<never> => {
      await store.markCredentialNeedsReauth(row.id);
      throw new CredentialError(
        "needs_reauth",
        `The ${row.name} credential's token expired and cannot be refreshed. Reconnect it in Oxagen, then retry.`,
      );
    };
    if (client === null) {
      // Nothing to refresh with: use the token until it expires.
      if (secrets.accessToken !== null && unexpired(row.expiresAt)) {
        return { type: "bearer", token: secrets.accessToken };
      }
      return reconnect();
    }

    const options = { fetch: fetchImpl, signal, timeoutMs: deps.timeoutMs, now: now() };
    let token: TokenSet;
    try {
      const server = await authorizationServer(request, signal);
      if (secrets.refreshToken !== null) {
        token = await refreshGrant(
          { tokenEndpoint: server.refreshEndpoint, client, refreshToken: secrets.refreshToken },
          options,
        );
      } else if (client.clientSecret !== null) {
        const scopes = row.scopes.length > 0 ? row.scopes : (request.auth.apply.scopes ?? []);
        token = await clientCredentialsGrant({ tokenEndpoint: server.tokenEndpoint, client, scopes }, options);
      } else {
        return await reconnect();
      }
    } catch (error) {
      if (error instanceof OAuthRefusedError) {
        // Another process may have refreshed first and spent the refresh
        // token. Its token is on the row now.
        const latest = await store.credentialById(row.id);
        if (latest !== null && latest.lastRefreshedAt?.getTime() !== row.lastRefreshedAt?.getTime()) {
          const current = await open(latest);
          if (current.accessToken !== null && unexpired(latest.expiresAt)) {
            return { type: "bearer", token: current.accessToken };
          }
        }
        return reconnect();
      }
      if (error instanceof OAuthUnavailableError && secrets.accessToken !== null && unexpired(row.expiresAt)) {
        // The token is inside the refresh window but has not expired, so the
        // call can still use it.
        return { type: "bearer", token: secrets.accessToken };
      }
      throw error;
    }

    const refreshedAt = now();
    const sealed = await encryptCredentialSecrets(
      {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? secrets.refreshToken,
        secret: secrets.secret,
        oauthClientSecret: secrets.oauthClientSecret,
      },
      requireKms(),
    );
    await store.saveCredentialTokens(row.id, {
      sealed,
      expiresAt: token.expiresAt,
      scopes: token.scopes ?? row.scopes,
      refreshedAt,
    });
    return { type: "bearer", token: token.accessToken };
  };

  // ── Operator-oauth mode ──────────────────────────────────────────────────

  const operatorCredential = async (
    request: CredentialRequest,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> => {
    const operator = request.operator;
    if (operator === undefined || !UUID.test(operator)) {
      throw new CredentialError(
        "no_operator",
        `The ${request.server} server signs in as the person who operates the run, and this call names no operator.`,
      );
    }
    if (!(await store.isMember(operator))) {
      // The operator left the workspace. Revoke what they connected, so no
      // later run can call the server as them.
      await revokeOperatorTokens(operator, {
        store,
        kms,
        fetch: fetchImpl,
        signal,
        timeoutMs: deps.timeoutMs,
      });
      return missing(request);
    }
    const row = await store.operatorToken({
      userId: operator,
      server: request.server,
      environment: request.environment,
    });
    if (row === null || row.status !== "active") return missing(request);
    const secrets = await open({
      tokenKmsKeyId: row.tokenKmsKeyId,
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc: row.refreshTokenEnc,
      oauthClientSecretEnc: row.clientSecretEnc,
    });
    if (secrets.accessToken !== null && fresh(row.expiresAt)) {
      return { type: "bearer", token: secrets.accessToken };
    }
    return once(row.id, signal, (shared) => refreshOperatorToken(request, row, secrets, shared));
  };

  const refreshOperatorToken = async (
    request: CredentialRequest,
    row: StoredOperatorToken,
    secrets: Secrets,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> => {
    const stillValid = secrets.accessToken !== null && unexpired(row.expiresAt);
    if (secrets.refreshToken === null) {
      if (stillValid && secrets.accessToken !== null) return { type: "bearer", token: secrets.accessToken };
      await store.markOperatorTokenNeedsReauth(row.id);
      return missing(request);
    }
    const clientSecret = await operatorClientSecret(row, secrets);
    let token: TokenSet;
    try {
      token = await refreshGrant(
        {
          tokenEndpoint: row.tokenEndpoint,
          client: { clientId: row.clientId, clientSecret },
          refreshToken: secrets.refreshToken,
        },
        { fetch: fetchImpl, signal, timeoutMs: deps.timeoutMs, now: now() },
      );
    } catch (error) {
      if (error instanceof OAuthRefusedError) {
        const latest = await store.operatorToken({
          userId: row.userId,
          server: row.server,
          environment: row.environment,
        });
        if (
          latest !== null &&
          latest.status === "active" &&
          latest.lastRefreshedAt?.getTime() !== row.lastRefreshedAt?.getTime() &&
          unexpired(latest.expiresAt)
        ) {
          const current = await open({ tokenKmsKeyId: latest.tokenKmsKeyId, accessTokenEnc: latest.accessTokenEnc });
          if (current.accessToken !== null) return { type: "bearer", token: current.accessToken };
        }
        await store.markOperatorTokenNeedsReauth(row.id);
        return missing(request);
      }
      if (error instanceof OAuthUnavailableError && stillValid && secrets.accessToken !== null) {
        return { type: "bearer", token: secrets.accessToken };
      }
      throw error;
    }

    const refreshedAt = now();
    const sealed = await encryptCredentialSecrets(
      {
        accessToken: token.accessToken,
        // A server that rotates refresh tokens sends a new one. One that
        // does not keeps the old one good.
        refreshToken: token.refreshToken ?? secrets.refreshToken,
        oauthClientSecret: secrets.oauthClientSecret,
      },
      requireKms(),
    );
    if (sealed.accessTokenEnc === null) {
      throw new CredentialError("unusable", "The authorization server returned an empty access token.");
    }
    await store.updateOperatorToken(row.id, {
      accessTokenEnc: sealed.accessTokenEnc,
      refreshTokenEnc: sealed.refreshTokenEnc,
      clientSecretEnc: sealed.oauthClientSecretEnc,
      tokenKmsKeyId: sealed.tokenKmsKeyId,
      expiresAt: token.expiresAt,
      scopes: token.scopes ?? row.scopes,
      refreshedAt,
    });
    return { type: "bearer", token: token.accessToken };
  };

  /** The client secret a refresh sends: the row's own, or the named client's. */
  const operatorClientSecret = async (
    row: StoredOperatorToken,
    secrets: Secrets,
  ): Promise<string | null> => {
    if (secrets.oauthClientSecret !== null || row.credentialId === null) return secrets.oauthClientSecret;
    const client = await store.credentialById(row.credentialId);
    if (client === null) return null;
    return (await open(client)).oauthClientSecret;
  };

  return {
    resolve(request, signal) {
      return request.auth.mode === "operator-oauth"
        ? operatorCredential(request, signal)
        : serviceCredential(request, signal);
    },
  };
}
