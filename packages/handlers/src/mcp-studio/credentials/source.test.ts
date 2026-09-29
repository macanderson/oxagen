// The CredentialSource against an in-memory store and a scripted
// authorization server: every service scheme, OAuth client credentials with
// caching, refresh before expiry, expiry, rotation, a refused refresh, and
// the operator-oauth mode with its missing token and connect link.
import { randomUUID } from "node:crypto";
import type { CredentialRequest, ResolvedCredential, SecurityScheme } from "@oxagen/mcp-studio";
import { encryptCredentialSecrets } from "@oxagen/plugins";
import { beforeEach, describe, expect, it } from "vitest";
import { OAuthUnavailableError } from "./oauth";
import { CredentialError, createCredentialSource, REFRESH_SKEW_MS } from "./source";
import {
  basicClient,
  json,
  manifestServer,
  MemoryCredentialStore,
  noFetch,
  type ScriptedFetch,
  scriptedFetch,
  testKms,
} from "./test-support";

const kms = testKms();
const T0 = new Date("2026-09-28T12:00:00Z");
const TOKEN_URL = "https://auth.example.com/token";
const REVOKE_URL = "https://auth.example.com/revoke";
const OPERATOR = randomUUID();
const signal = new AbortController().signal;
const oauth2: SecurityScheme = { type: "oauth2", token_url: TOKEN_URL, scopes: ["read"] };

let clock: Date;
let store: MemoryCredentialStore;

beforeEach(() => {
  clock = T0;
  store = new MemoryCredentialStore(kms);
  store.members.add(OPERATOR);
});

function later(ms: number): Date {
  return new Date(clock.getTime() + ms);
}

function source(
  fetch: ScriptedFetch = noFetch(),
  options: { network?: string; kms?: typeof kms | null } = {},
) {
  const server = manifestServer({
    auth: null,
    environments: {
      sandbox: { url: "https://billing.example.com/mcp", ...(options.network ? { network: options.network } : {}) },
    },
  });
  return createCredentialSource({
    store,
    server: (name) => (name === "billing" ? server : undefined),
    connectUrl: ({ server: name, environment }) =>
      `https://api.example.com/v1/acme/tools/mcp-studio/oauth/connect?server=${name}&environment=${environment}`,
    fetch,
    now: () => clock,
    kms: options.kms === undefined ? kms : options.kms,
  });
}

function service(apply: SecurityScheme, reference = "oxagen:credential/billing-key"): CredentialRequest {
  return {
    server: "billing",
    environment: "sandbox",
    reference,
    auth: { mode: "service", scheme: "default", apply },
    operator: undefined,
  };
}

function operator(who: string | undefined): CredentialRequest {
  return {
    server: "billing",
    environment: "sandbox",
    reference: undefined,
    auth: { mode: "operator-oauth", scheme: "oauth", apply: oauth2 },
    operator: who,
  };
}

async function failure(promise: Promise<ResolvedCredential>): Promise<CredentialError> {
  const error: unknown = await promise.then(
    () => new Error("resolved"),
    (reason: unknown) => reason,
  );
  if (!(error instanceof CredentialError)) throw new Error(`expected a CredentialError, got ${String(error)}`);
  return error;
}

/** A token endpoint that issues `tokens` in order. */
function tokenServer(...tokens: Array<Record<string, unknown> | Response>): ScriptedFetch {
  let next = 0;
  return scriptedFetch(() => {
    const answer = tokens[Math.min(next, tokens.length - 1)];
    next += 1;
    if (answer === undefined) throw new Error("no token scripted");
    // A clone, so the same scripted answer can be read more than once.
    return answer instanceof Response ? answer.clone() : json(200, { token_type: "Bearer", ...answer });
  });
}

describe("service mode: a secret from the vault", () => {
  it.each(["header", "query", "cookie"] as const)("resolves an API key the scheme puts in a %s", async (where) => {
    await store.addCredential({ name: "billing-key", secret: "sk_live_4242" });
    const resolved = await source().resolve(service({ type: "api_key", in: where, name: "X-Api-Key" }), signal);
    expect(resolved).toEqual({ type: "api_key", value: "sk_live_4242" });
  });

  it("resolves a bearer token", async () => {
    await store.addCredential({ name: "billing-key", secret: "bt_123" });
    const resolved = await source().resolve(service({ type: "http_bearer" }), signal);
    expect(resolved).toEqual({ type: "bearer", token: "bt_123" });
  });

  it("uses a stored access token when the row holds no secret", async () => {
    await store.addCredential({ name: "billing-key", accessToken: "at_static" });
    const resolved = await source().resolve(service({ type: "http_bearer" }), signal);
    expect(resolved).toEqual({ type: "bearer", token: "at_static" });
  });

  it("splits a basic pair at the first colon, as RFC 7617 does", async () => {
    await store.addCredential({ name: "billing-key", secret: "ada:pass:word" });
    const resolved = await source().resolve(service({ type: "http_basic" }), signal);
    expect(resolved).toEqual({ type: "basic", username: "ada", password: "pass:word" });
  });

  it("refuses a basic secret that is not a username:password pair, without quoting it", async () => {
    await store.addCredential({ name: "billing-key", secret: "nocolonsecret" });
    const error = await failure(source().resolve(service({ type: "http_basic" }), signal));
    expect(error.code).toBe("unusable");
    expect(error.message).not.toContain("nocolonsecret");
  });

  it("refuses mutual TLS, which Oxagen sends no certificate for", async () => {
    await store.addCredential({ name: "billing-key", secret: "unused" });
    const error = await failure(source().resolve(service({ type: "mutual_tls" }), signal));
    expect(error.code).toBe("unsupported");
  });

  it("refuses a row that holds no secret", async () => {
    await store.addCredential({ name: "billing-key" });
    const error = await failure(source().resolve(service({ type: "http_bearer" }), signal));
    expect(error.code).toBe("unusable");
  });

  it("refuses an environment that names no credential", async () => {
    // Passing undefined to service() would take its default reference, so clear the field instead.
    const request = { ...service({ type: "http_bearer" }), reference: undefined };
    const error = await failure(source().resolve(request, signal));
    expect(error.code).toBe("no_reference");
  });

  it("refuses a reference that is not oxagen:credential/<name>", async () => {
    const error = await failure(source().resolve(service({ type: "http_bearer" }, "vault://billing"), signal));
    expect(error.code).toBe("no_reference");
  });

  it("refuses a name the workspace does not hold", async () => {
    const error = await failure(source().resolve(service({ type: "http_bearer" }), signal));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("billing-key");
  });

  it.each([
    ["revoked", "revoked"],
    ["needs_reauth", "needs_reauth"],
  ] as const)("refuses a %s credential", async (status, code) => {
    await store.addCredential({ name: "billing-key", secret: "sk", status });
    const error = await failure(source().resolve(service({ type: "http_bearer" }), signal));
    expect(error.code).toBe(code);
  });

  it("refuses an OAuth credential for a scheme that takes a secret", async () => {
    await store.addCredential({ name: "billing-key", authKind: "oauth", accessToken: "at" });
    const error = await failure(
      source().resolve(service({ type: "api_key", in: "header", name: "X-Api-Key" }), signal),
    );
    expect(error.code).toBe("unusable");
  });

  it("reports a missing vault key instead of reading ciphertext", async () => {
    await store.addCredential({ name: "billing-key", secret: "sk" });
    const error = await failure(source(noFetch(), { kms: null }).resolve(service({ type: "http_bearer" }), signal));
    expect(error.code).toBe("vault");
  });
});

describe("service mode: a credential the relay holds", () => {
  const relay = { network: "relay:acme-dc" };

  it.each([
    [{ type: "http_bearer" } as SecurityScheme, { name: "billing-key", scheme: "bearer" }],
    [oauth2, { name: "billing-key", scheme: "bearer" }],
    [{ type: "http_basic" } as SecurityScheme, { name: "billing-key", scheme: "basic" }],
    [
      { type: "api_key", in: "header", name: "X-Api-Key" } as SecurityScheme,
      { name: "billing-key", scheme: "header", header: "X-Api-Key" },
    ],
    [{ type: "mutual_tls" } as SecurityScheme, { name: "billing-key", scheme: "mutual_tls" }],
  ])("names the relay credential for %o", async (apply, credential) => {
    const resolved = await source(noFetch(), relay).resolve(service(apply), signal);
    expect(resolved).toEqual({ type: "relay", credential });
  });

  it.each(["query", "cookie"] as const)("refuses a relay API key in a %s", async (where) => {
    const error = await failure(
      source(noFetch(), relay).resolve(service({ type: "api_key", in: where, name: "key" }), signal),
    );
    expect(error.code).toBe("unsupported");
  });

  it("uses the vault's row when the workspace holds one", async () => {
    await store.addCredential({ name: "billing-key", secret: "sk_vault" });
    const resolved = await source(noFetch(), relay).resolve(service({ type: "http_bearer" }), signal);
    expect(resolved).toEqual({ type: "bearer", token: "sk_vault" });
  });

  it("refuses a vault row for a mutual TLS server, since the certificate stays with the relay", async () => {
    await store.addCredential({ name: "billing-key", secret: "unused" });
    const error = await failure(source(noFetch(), relay).resolve(service({ type: "mutual_tls" }), signal));
    expect(error.code).toBe("unsupported");
  });
});

describe("service mode: OAuth client credentials", () => {
  async function clientCredential() {
    return store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      oauthClientId: "client-1",
      oauthClientSecret: "cs-1",
    });
  }

  it("fetches a token, caches it, and fetches again inside the refresh window", async () => {
    const row = await clientCredential();
    const fetch = tokenServer({ access_token: "at-1", expires_in: 3600 }, { access_token: "at-2", expires_in: 3600 });
    const credentials = source(fetch);

    expect(await credentials.resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-1" });
    const [sent] = fetch.sent;
    expect(sent?.url).toBe(TOKEN_URL);
    expect(sent?.form?.get("grant_type")).toBe("client_credentials");
    expect(sent?.form?.get("scope")).toBe("read");
    expect(basicClient(sent?.headers.authorization)).toEqual({ clientId: "client-1", clientSecret: "cs-1" });
    expect(sent?.form?.has("client_secret")).toBe(false);

    const saved = store.credentials.get(row.id);
    expect(saved?.expiresAt).toEqual(later(3600_000));
    expect(saved?.lastRefreshedAt).toEqual(T0);
    expect((await store.openCredential(row.id)).accessToken).toBe("at-1");
    expect((await store.openCredential(row.id)).oauthClientSecret).toBe("cs-1");

    // Cached: the next call sends nothing.
    clock = later(3600_000 - REFRESH_SKEW_MS - 1);
    expect(await credentials.resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-1" });
    expect(fetch.sent).toHaveLength(1);

    // Inside the minute before expiry: a new token.
    clock = later(2);
    expect(await credentials.resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-2" });
    expect(fetch.sent).toHaveLength(2);
  });

  it("asks for the credential's own scopes before the scheme's", async () => {
    await store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      oauthClientId: "client-1",
      oauthClientSecret: "cs-1",
      scopes: ["invoices:read", "invoices:write"],
    });
    const fetch = tokenServer({ access_token: "at-1" });
    await source(fetch).resolve(service(oauth2), signal);
    expect(fetch.sent[0]?.form?.get("scope")).toBe("invoices:read invoices:write");
  });

  it("retries with the secret in the body when the server refuses Basic", async () => {
    await clientCredential();
    const fetch = tokenServer(json(401, { error: "invalid_client" }), { access_token: "at-1" });
    expect(await source(fetch).resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-1" });
    expect(fetch.sent[1]?.form?.get("client_secret")).toBe("cs-1");
  });

  it("shares one request between two calls that find the token expiring", async () => {
    await clientCredential();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = scriptedFetch(async () => {
      await gate;
      return json(200, { access_token: "at-shared", expires_in: 3600 });
    });
    const credentials = source(fetch);
    const first = credentials.resolve(service(oauth2), signal);
    const second = credentials.resolve(service(oauth2), signal);
    release();
    expect(await first).toEqual({ type: "bearer", token: "at-shared" });
    expect(await second).toEqual({ type: "bearer", token: "at-shared" });
    expect(fetch.sent).toHaveLength(1);
  });

  it("finds the token endpoint through the server's metadata when the scheme names none", async () => {
    await clientCredential();
    const fetch = scriptedFetch((request) => {
      if (request.url === "https://billing.example.com/.well-known/oauth-protected-resource/mcp") {
        return json(200, { resource: "https://billing.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return json(200, { issuer: "https://auth.example.com", token_endpoint: TOKEN_URL });
      }
      if (request.url === TOKEN_URL) return json(200, { access_token: "at-found" });
      return json(404, {});
    });
    const resolved = await source(fetch).resolve(service({ type: "oauth2" }), signal);
    expect(resolved).toEqual({ type: "bearer", token: "at-found" });
  });
});

describe("service mode: refresh, expiry, and rotation", () => {
  async function refreshable(expiresAt: Date, extra: { lastRefreshedAt?: Date } = {}) {
    return store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      oauthClientId: "client-1",
      oauthClientSecret: "cs-1",
      accessToken: "at-old",
      refreshToken: "rt-1",
      expiresAt,
      ...extra,
    });
  }

  it("uses a token that expires after the refresh window without a request", async () => {
    await refreshable(later(10 * 60_000));
    expect(await source().resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-old" });
  });

  it("refreshes a token inside the minute before it expires and stores the rotated refresh token", async () => {
    const row = await refreshable(later(30_000));
    const fetch = tokenServer(
      { access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 },
      { access_token: "at-newer", expires_in: 3600 },
    );
    const credentials = source(fetch);

    expect(await credentials.resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-new" });
    expect(fetch.sent[0]?.form?.get("grant_type")).toBe("refresh_token");
    expect(fetch.sent[0]?.form?.get("refresh_token")).toBe("rt-1");
    expect(await store.openCredential(row.id)).toMatchObject({ accessToken: "at-new", refreshToken: "rt-2" });

    // The next refresh sends the rotated token. A server that does not
    // rotate leaves the last one good.
    clock = later(3600_000);
    expect(await credentials.resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-newer" });
    expect(fetch.sent[1]?.form?.get("refresh_token")).toBe("rt-2");
    expect(await store.openCredential(row.id)).toMatchObject({ accessToken: "at-newer", refreshToken: "rt-2" });
  });

  it("refreshes an expired token", async () => {
    await refreshable(later(-60_000));
    const fetch = tokenServer({ access_token: "at-new", expires_in: 3600 });
    expect(await source(fetch).resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-new" });
  });

  it("sends the refresh to the scheme's refresh_url when it names one", async () => {
    await refreshable(later(-1));
    const fetch = tokenServer({ access_token: "at-new" });
    const apply: SecurityScheme = { ...oauth2, refresh_url: "https://auth.example.com/refresh" };
    await source(fetch).resolve(service(apply), signal);
    expect(fetch.sent[0]?.url).toBe("https://auth.example.com/refresh");
  });

  it("marks the credential for reconnect when the server refuses the refresh", async () => {
    const row = await refreshable(later(-1));
    const fetch = tokenServer(json(400, { error: "invalid_grant" }));
    const error = await failure(source(fetch).resolve(service(oauth2), signal));
    expect(error.code).toBe("needs_reauth");
    expect(error.message).not.toContain("rt-1");
    expect(store.credentials.get(row.id)?.status).toBe("needs_reauth");
  });

  it("uses the token another process stored when the refresh token was already spent", async () => {
    const row = await refreshable(later(-1), { lastRefreshedAt: later(-3600_000) });
    const fetch = scriptedFetch(async () => {
      // Another API process refreshed first and rotated the refresh token.
      const sealed = await encryptCredentialSecrets(
        { accessToken: "at-other", refreshToken: "rt-other", oauthClientSecret: "cs-1" },
        kms,
      );
      await store.saveCredentialTokens(row.id, {
        sealed,
        expiresAt: later(3600_000),
        scopes: [],
        refreshedAt: later(-1000),
      });
      return json(400, { error: "invalid_grant" });
    });
    const resolved = await source(fetch).resolve(service(oauth2), signal);
    expect(resolved).toEqual({ type: "bearer", token: "at-other" });
    expect(store.credentials.get(row.id)?.status).toBe("active");
  });

  it("keeps using an unexpired token when the token endpoint is down", async () => {
    await refreshable(later(30_000));
    const fetch = tokenServer(json(503, {}));
    expect(await source(fetch).resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-old" });
  });

  it("rejects when the token expired and the token endpoint is down", async () => {
    await refreshable(later(-1));
    const fetch = tokenServer(json(503, {}));
    await expect(source(fetch).resolve(service(oauth2), signal)).rejects.toBeInstanceOf(OAuthUnavailableError);
  });

  it("uses a token with no client until it expires, then asks for a reconnect", async () => {
    const row = await store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      accessToken: "at-only",
      expiresAt: later(30_000),
    });
    expect(await source().resolve(service(oauth2), signal)).toEqual({ type: "bearer", token: "at-only" });
    clock = later(30_001);
    const error = await failure(source().resolve(service(oauth2), signal));
    expect(error.code).toBe("needs_reauth");
    expect(store.credentials.get(row.id)?.status).toBe("needs_reauth");
  });

  it("asks for a reconnect when a public client has no refresh token", async () => {
    await store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      oauthClientId: "public-client",
      accessToken: "at",
      expiresAt: later(-1),
    });
    const error = await failure(source().resolve(service(oauth2), signal));
    expect(error.code).toBe("needs_reauth");
  });
});

describe("operator-oauth mode", () => {
  const key = { userId: OPERATOR, server: "billing", environment: "sandbox" };

  it("answers the spec's message and the connect link when the operator has no token", async () => {
    const resolved = await source().resolve(operator(OPERATOR), signal);
    expect(resolved).toEqual({
      type: "missing",
      message: "Connect your Billing API account in Oxagen, then retry.",
      connect_url: "https://api.example.com/v1/acme/tools/mcp-studio/oauth/connect?server=billing&environment=sandbox",
    });
  });

  it("refuses a call that names no operator", async () => {
    expect((await failure(source().resolve(operator(undefined), signal))).code).toBe("no_operator");
    expect((await failure(source().resolve(operator("usr_not_a_uuid"), signal))).code).toBe("no_operator");
  });

  it("resolves the operator's own token", async () => {
    await store.addOperatorToken({ ...key, accessToken: "op-at", expiresAt: later(3600_000) });
    await store.addOperatorToken({ ...key, userId: randomUUID(), accessToken: "someone-else" });
    expect(await source().resolve(operator(OPERATOR), signal)).toEqual({ type: "bearer", token: "op-at" });
  });

  it("refreshes before expiry with the row's client and stores the rotated refresh token", async () => {
    const row = await store.addOperatorToken({
      ...key,
      accessToken: "op-old",
      refreshToken: "op-rt-1",
      clientId: "registered-1",
      clientSecret: "registered-secret",
      tokenEndpoint: TOKEN_URL,
      expiresAt: later(30_000),
      scopes: ["read"],
    });
    const fetch = tokenServer({ access_token: "op-new", refresh_token: "op-rt-2", expires_in: 3600, scope: "read write" });
    expect(await source(fetch).resolve(operator(OPERATOR), signal)).toEqual({ type: "bearer", token: "op-new" });

    const [sent] = fetch.sent;
    expect(sent?.url).toBe(TOKEN_URL);
    expect(sent?.form?.get("refresh_token")).toBe("op-rt-1");
    expect(basicClient(sent?.headers.authorization)).toEqual({
      clientId: "registered-1",
      clientSecret: "registered-secret",
    });
    const saved = store.tokens.get(row.id);
    expect(saved).toMatchObject({ status: "active", scopes: ["read", "write"], lastRefreshedAt: T0 });
    expect(saved?.expiresAt).toEqual(later(3600_000));
    expect(await store.openToken(row.id)).toMatchObject({
      accessToken: "op-new",
      refreshToken: "op-rt-2",
      oauthClientSecret: "registered-secret",
    });
  });

  it("refreshes with a named client's secret when the row holds none", async () => {
    const client = await store.addCredential({
      name: "billing-client",
      authKind: "oauth",
      oauthClientId: "named-1",
      oauthClientSecret: "named-secret",
    });
    await store.addOperatorToken({
      ...key,
      accessToken: "op-old",
      refreshToken: "op-rt-1",
      clientId: "named-1",
      credentialId: client.id,
      expiresAt: later(-1),
    });
    const fetch = tokenServer({ access_token: "op-new" });
    await source(fetch).resolve(operator(OPERATOR), signal);
    expect(basicClient(fetch.sent[0]?.headers.authorization)).toEqual({
      clientId: "named-1",
      clientSecret: "named-secret",
    });
  });

  it("marks an expired token with no refresh token and answers the connect link", async () => {
    const row = await store.addOperatorToken({ ...key, accessToken: "op-old", expiresAt: later(-1) });
    const resolved = await source().resolve(operator(OPERATOR), signal);
    expect(resolved.type).toBe("missing");
    expect(store.tokens.get(row.id)?.status).toBe("needs_reauth");
    // A row that needs a reconnect stays missing, and nothing is sent.
    expect((await source().resolve(operator(OPERATOR), signal)).type).toBe("missing");
  });

  it("uses a token with no refresh token until it expires", async () => {
    await store.addOperatorToken({ ...key, accessToken: "op-short", expiresAt: later(30_000) });
    expect(await source().resolve(operator(OPERATOR), signal)).toEqual({ type: "bearer", token: "op-short" });
  });

  it("answers the connect link when the server refuses the refresh", async () => {
    const row = await store.addOperatorToken({
      ...key,
      accessToken: "op-old",
      refreshToken: "op-rt-1",
      expiresAt: later(-1),
    });
    const fetch = tokenServer(json(400, { error: "invalid_grant" }));
    const resolved = await source(fetch).resolve(operator(OPERATOR), signal);
    expect(resolved.type).toBe("missing");
    expect(store.tokens.get(row.id)?.status).toBe("needs_reauth");
  });

  it("uses the token another process stored when the refresh token was already spent", async () => {
    const row = await store.addOperatorToken({
      ...key,
      accessToken: "op-old",
      refreshToken: "op-rt-1",
      expiresAt: later(-1),
      lastRefreshedAt: later(-3600_000),
    });
    const fetch = scriptedFetch(async () => {
      const sealed = await encryptCredentialSecrets({ accessToken: "op-other", refreshToken: "op-rt-other" }, kms);
      if (sealed.accessTokenEnc === null) throw new Error("sealed nothing");
      await store.updateOperatorToken(row.id, {
        accessTokenEnc: sealed.accessTokenEnc,
        refreshTokenEnc: sealed.refreshTokenEnc,
        clientSecretEnc: null,
        tokenKmsKeyId: sealed.tokenKmsKeyId,
        expiresAt: later(3600_000),
        scopes: [],
        refreshedAt: later(-1000),
      });
      return json(400, { error: "invalid_grant" });
    });
    expect(await source(fetch).resolve(operator(OPERATOR), signal)).toEqual({ type: "bearer", token: "op-other" });
    expect(store.tokens.get(row.id)?.status).toBe("active");
  });

  it("keeps using an unexpired token when the token endpoint is down, and rejects once it expired", async () => {
    await store.addOperatorToken({
      ...key,
      accessToken: "op-old",
      refreshToken: "op-rt-1",
      expiresAt: later(30_000),
    });
    const fetch = tokenServer(json(502, {}));
    expect(await source(fetch).resolve(operator(OPERATOR), signal)).toEqual({ type: "bearer", token: "op-old" });
    clock = later(30_001);
    await expect(source(fetch).resolve(operator(OPERATOR), signal)).rejects.toBeInstanceOf(OAuthUnavailableError);
  });

  it("revokes and deletes the tokens of an operator who left the workspace", async () => {
    store.members.delete(OPERATOR);
    const row = await store.addOperatorToken({
      ...key,
      accessToken: "op-at",
      refreshToken: "op-rt",
      clientSecret: "cs",
      revocationEndpoint: REVOKE_URL,
      expiresAt: later(3600_000),
    });
    const fetch = scriptedFetch(() => new Response(null, { status: 200 }));
    const resolved = await source(fetch).resolve(operator(OPERATOR), signal);
    expect(resolved.type).toBe("missing");
    expect(store.tokens.has(row.id)).toBe(false);
    expect(fetch.sent.map((sent) => [sent.url, sent.form?.get("token_type_hint")])).toEqual([
      [REVOKE_URL, "refresh_token"],
      [REVOKE_URL, "access_token"],
    ]);
  });

  it("names the server itself when the published manifest has no label for it", async () => {
    const credentials = createCredentialSource({
      store,
      server: () => undefined,
      connectUrl: () => "https://api.example.com/connect",
      fetch: noFetch(),
      kms,
    });
    const resolved = await credentials.resolve(operator(OPERATOR), signal);
    expect(resolved).toMatchObject({ message: "Connect your billing account in Oxagen, then retry." });
  });
});

describe("no secret leaves in an error", () => {
  const secrets = ["at-secret-1", "rt-secret-1", "cs-secret-1"];

  async function expiring() {
    await store.addCredential({
      name: "billing-key",
      authKind: "oauth",
      oauthClientId: "client-1",
      oauthClientSecret: "cs-secret-1",
      accessToken: "at-secret-1",
      refreshToken: "rt-secret-1",
      expiresAt: later(-1),
    });
  }

  it("names no token, refresh token, or client secret when the server refuses the refresh", async () => {
    await expiring();
    const fetch = tokenServer(json(400, { error: "invalid_grant", error_description: "rt-secret-1 is spent" }));
    const error = await failure(source(fetch).resolve(service(oauth2), signal));
    for (const secret of secrets) expect(error.message).not.toContain(secret);
  });

  it("names no token, refresh token, or client secret when the server is down", async () => {
    await expiring();
    const error: unknown = await source(tokenServer(json(503, {})))
      .resolve(service(oauth2), signal)
      .then(
        () => new Error("resolved"),
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(OAuthUnavailableError);
    for (const secret of secrets) expect((error as Error).message).not.toContain(secret);
  });
});
