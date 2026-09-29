// Connect, callback, and disconnect for an operator-oauth server, against an
// in-memory store and a scripted authorization server: discovery through RFC
// 9728 and RFC 8414, dynamic registration, PKCE, the one-time state, a named
// client, the old grant a reconnect replaces, and each refusal's status.
import { createHash, randomUUID } from "node:crypto";
import type { ManifestAuth, ManifestServer } from "@oxagen/mcp-studio";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginConnect,
  CONNECT_STATE_TTL_MS,
  type ConnectDeps,
  ConnectError,
  disconnect,
  finishConnect,
  mcpStudioConnectLink,
  workspaceCredentialSource,
} from "./connect";
import type { ConnectState } from "./store";
import {
  basicClient,
  json,
  manifestServer,
  MemoryConnectStateStore,
  MemoryCredentialStore,
  type ScriptedFetch,
  scriptedFetch,
  type SentRequest,
  testKms,
} from "./test-support";

const kms = testKms();
const T0 = new Date("2026-09-28T12:00:00Z");
const SCOPE = { orgId: randomUUID(), workspaceId: randomUUID() };
const USER = randomUUID();
const TARGET = { ...SCOPE, userId: USER, server: "billing", environment: "sandbox" };
const KEY = { userId: USER, server: "billing", environment: "sandbox" };
const REDIRECT = "https://api.example.com/oauth/mcp-studio/callback";
const SERVER_URL = "https://billing.example.com/mcp";
const RESOURCE_METADATA = "https://billing.example.com/.well-known/oauth-protected-resource/mcp";
const ISSUER_METADATA = "https://auth.example.com/.well-known/oauth-authorization-server";
const AUTHORIZE_URL = "https://auth.example.com/authorize";
const TOKEN_URL = "https://auth.example.com/token";
const REVOKE_URL = "https://auth.example.com/revoke";
const REGISTER_URL = "https://auth.example.com/register";
const operatorOauth: ManifestAuth = {
  mode: "operator-oauth",
  scheme: "oauth",
  apply: { type: "oauth2", scopes: ["invoices:read"] },
};

let clock: Date;
let store: MemoryCredentialStore;
let states: MemoryConnectStateStore;
let servers: Map<string, ManifestServer>;

beforeEach(() => {
  clock = T0;
  store = new MemoryCredentialStore(kms);
  store.members.add(USER);
  states = new MemoryConnectStateStore();
  servers = new Map([["billing", manifestServer({ auth: operatorOauth })]]);
});

function deps(fetch: ScriptedFetch, overrides: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    store: () => store,
    states,
    servers: () => Promise.resolve(servers),
    fetch,
    now: () => clock,
    kms,
    ...overrides,
  };
}

interface AuthServerOptions {
  /** The metadata names a registration endpoint. */
  register?: boolean;
  /** The authorization server's metadata, merged over the default. */
  metadata?: Record<string, unknown>;
  /** What the token endpoint answers. */
  token?: () => Response;
  /** What the revocation endpoint answers. */
  revoke?: () => Response;
}

/** An MCP server and its authorization server, as RFC 9728 and RFC 8414 describe them. */
function authServer(options: AuthServerOptions = {}): ScriptedFetch {
  return scriptedFetch((request: SentRequest) => {
    switch (request.url) {
      case RESOURCE_METADATA:
        return json(200, { resource: SERVER_URL, authorization_servers: ["https://auth.example.com"] });
      case ISSUER_METADATA:
        return json(200, {
          issuer: "https://auth.example.com",
          authorization_endpoint: AUTHORIZE_URL,
          token_endpoint: TOKEN_URL,
          revocation_endpoint: REVOKE_URL,
          ...(options.register === false ? {} : { registration_endpoint: REGISTER_URL }),
          ...options.metadata,
        });
      case REGISTER_URL:
        return json(201, { client_id: "registered-1", client_secret: "registered-secret" });
      case TOKEN_URL:
        return options.token?.() ??
          json(200, {
            access_token: "op-at",
            refresh_token: "op-rt",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "invoices:read",
          });
      case REVOKE_URL:
        return options.revoke?.() ?? new Response(null, { status: 200 });
      default:
        return json(404, {});
    }
  });
}

async function refusal(promise: Promise<unknown>): Promise<ConnectError> {
  const error: unknown = await promise.then(
    () => new Error("resolved"),
    (reason: unknown) => reason,
  );
  if (!(error instanceof ConnectError)) throw new Error(`expected a ConnectError, got ${String(error)}`);
  return error;
}

function storedState(state: string): ConnectState {
  const row = states.rows.get(state);
  if (row === undefined) throw new Error("no state stored");
  return JSON.parse(row.value) as ConnectState;
}

function sentTo(fetch: ScriptedFetch, url: string): SentRequest[] {
  return fetch.sent.filter((request) => request.url === url);
}

describe("beginConnect and finishConnect with a registered client", () => {
  it("sends the operator to the authorization server with PKCE, the resource, and a one-time state", async () => {
    const fetch = authServer();
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));

    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "registered-1",
      redirect_uri: REDIRECT,
      state: started.state,
      code_challenge_method: "S256",
      scope: "invoices:read",
      resource: SERVER_URL,
    });

    const [registration] = sentTo(fetch, REGISTER_URL);
    expect(registration?.json).toMatchObject({
      client_name: "Oxagen",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "invoices:read",
    });

    // The state holds the verifier whose S256 hash the URL carries, and no
    // plaintext client secret.
    const state = storedState(started.state);
    expect(createHash("sha256").update(state.codeVerifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(states.rows.get(started.state)?.value).not.toContain("registered-secret");
    expect(started.authorizationUrl).not.toContain("registered-secret");
    expect(state).toMatchObject({
      ...TARGET,
      label: "Billing API",
      credentialId: null,
      clientId: "registered-1",
      tokenEndpoint: TOKEN_URL,
      refreshEndpoint: TOKEN_URL,
      revocationEndpoint: REVOKE_URL,
      resource: SERVER_URL,
      redirectUri: REDIRECT,
      scopes: ["invoices:read"],
    });
    expect(state.clientSecretSealed).not.toBeNull();
    expect(states.rows.get(started.state)?.expiresAt).toEqual(new Date(T0.getTime() + CONNECT_STATE_TTL_MS));

    const connected = await finishConnect({ state: started.state, code: "code-1" }, deps(fetch));
    expect(connected).toEqual({ ...TARGET, label: "Billing API" });

    const [exchange] = sentTo(fetch, TOKEN_URL);
    expect(Object.fromEntries(exchange?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: REDIRECT,
      code_verifier: state.codeVerifier,
      resource: SERVER_URL,
    });
    expect(basicClient(exchange?.headers.authorization)).toEqual({
      clientId: "registered-1",
      clientSecret: "registered-secret",
    });

    const row = store.tokenFor(KEY);
    expect(row).toMatchObject({
      clientId: "registered-1",
      credentialId: null,
      tokenEndpoint: TOKEN_URL,
      revocationEndpoint: REVOKE_URL,
      scopes: ["invoices:read"],
      status: "active",
      expiresAt: new Date(T0.getTime() + 3600_000),
      lastRefreshedAt: T0,
    });
    expect(await store.openToken(row?.id ?? "")).toEqual({
      accessToken: "op-at",
      refreshToken: "op-rt",
      secret: null,
      oauthClientSecret: "registered-secret",
    });

    // The state is good for one callback.
    const again = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([again.status, again.code]).toEqual([400, "state"]);
  });

  it("refuses a callback after the state expires", async () => {
    const fetch = authServer();
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    clock = new Date(T0.getTime() + CONNECT_STATE_TTL_MS);
    const error = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([error.status, error.code]).toEqual([400, "state"]);
    expect(sentTo(fetch, TOKEN_URL)).toHaveLength(0);
  });

  it("stores the scopes the operator asked for when the token names none", async () => {
    const fetch = authServer({ token: () => json(200, { access_token: "op-at", token_type: "bearer" }) });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    await finishConnect({ state: started.state, code: "code-1" }, deps(fetch));
    expect(store.tokenFor(KEY)).toMatchObject({ scopes: ["invoices:read"], expiresAt: null });
  });
});

describe("a client the environment names", () => {
  beforeEach(() => {
    servers.set(
      "billing",
      manifestServer({
        auth: operatorOauth,
        environments: { sandbox: { url: SERVER_URL, credential: "oxagen:credential/billing-client" } },
      }),
    );
  });

  it("connects through the named client and keeps its secret off the token row", async () => {
    const client = await store.addCredential({
      name: "billing-client",
      authKind: "oauth",
      oauthClientId: "named-1",
      oauthClientSecret: "named-secret",
    });
    const fetch = authServer({ register: false });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("named-1");
    expect(sentTo(fetch, REGISTER_URL)).toHaveLength(0);
    expect(storedState(started.state)).toMatchObject({
      credentialId: client.id,
      clientSecretSealed: null,
      kmsKeyId: null,
    });

    await finishConnect({ state: started.state, code: "code-1" }, deps(fetch));
    expect(basicClient(sentTo(fetch, TOKEN_URL)[0]?.headers.authorization)).toEqual({
      clientId: "named-1",
      clientSecret: "named-secret",
    });
    const row = store.tokenFor(KEY);
    expect(row).toMatchObject({ clientId: "named-1", credentialId: client.id, clientSecretEnc: null });
  });

  it("refuses when the workspace holds no client by that name", async () => {
    const error = await refusal(beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(authServer())));
    expect([error.status, error.code]).toEqual([409, "no_client"]);
  });

  it("refuses when the named credential has no client id", async () => {
    await store.addCredential({ name: "billing-client", secret: "not-a-client" });
    const error = await refusal(beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(authServer())));
    expect([error.status, error.code]).toEqual([409, "no_client"]);
    expect(error.message).not.toContain("not-a-client");
  });

  it("refuses the callback when the client was removed during sign-in", async () => {
    const client = await store.addCredential({
      name: "billing-client",
      authKind: "oauth",
      oauthClientId: "named-1",
      oauthClientSecret: "named-secret",
    });
    const fetch = authServer({ register: false });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    store.credentials.delete(client.id);
    const error = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([error.status, error.code]).toEqual([409, "no_client"]);
    expect(store.tokenFor(KEY)).toBeUndefined();
  });
});

describe("beginConnect refusals", () => {
  const begin = (fetch: ScriptedFetch = authServer(), overrides: Partial<ConnectDeps> = {}) =>
    refusal(beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch, overrides)));

  it("answers 404 for a server the workspace has not published", async () => {
    servers.clear();
    const error = await begin();
    expect([error.status, error.code]).toEqual([404, "not_published"]);
  });

  it("answers 404 for an environment the server does not have", async () => {
    const error = await refusal(
      beginConnect({ ...TARGET, environment: "production", redirectUri: REDIRECT }, deps(authServer())),
    );
    expect([error.status, error.code]).toEqual([404, "not_published"]);
  });

  const notOperatorOauth: [string, ManifestAuth | null][] = [
    ["no auth", null],
    ["service auth", { mode: "service", scheme: "oauth", apply: { type: "oauth2" } }],
    ["a bearer scheme", { mode: "operator-oauth", scheme: "bearer", apply: { type: "http_bearer" } }],
  ];
  it.each(notOperatorOauth)("answers 400 for a server with %s", async (_why, auth) => {
    servers.set("billing", manifestServer({ auth }));
    const error = await begin();
    expect([error.status, error.code]).toEqual([400, "not_operator_oauth"]);
  });

  it("answers 403 for a person who is not a member of the workspace", async () => {
    store.members.clear();
    const fetch = authServer();
    const error = await begin(fetch);
    expect([error.status, error.code]).toEqual([403, "not_member"]);
    expect(fetch.sent).toHaveLength(0);
  });

  it("answers 503 when the vault has no key", async () => {
    const error = await begin(authServer(), { kms: null });
    expect([error.status, error.code]).toEqual([503, "vault"]);
  });

  it("answers 502 when the authorization server names no authorization endpoint", async () => {
    const error = await begin(authServer({ metadata: { authorization_endpoint: undefined } }));
    expect([error.status, error.code]).toEqual([502, "provider"]);
  });

  it("answers 409 when the server registers no clients and the environment names none", async () => {
    const error = await begin(authServer({ register: false }));
    expect([error.status, error.code]).toEqual([409, "no_client"]);
  });

  it("answers 400 when no OAuth metadata exists", async () => {
    const error = await begin(scriptedFetch(() => json(404, {})));
    expect([error.status, error.code]).toEqual([400, "refused"]);
  });

  it("answers 502 when the authorization server is down", async () => {
    const error = await begin(scriptedFetch(() => json(503, {})));
    expect([error.status, error.code]).toEqual([502, "provider"]);
  });

});

describe("finishConnect refusals", () => {
  it("answers 400 when the authorization server refuses the code, and stores nothing", async () => {
    const fetch = authServer({ token: () => json(400, { error: "invalid_grant" }) });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    const error = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([error.status, error.code]).toEqual([400, "refused"]);
    expect(error.message).not.toContain("code-1");
    expect(store.tokenFor(KEY)).toBeUndefined();
  });

  it("answers 502 when the token endpoint is down", async () => {
    const fetch = authServer({ token: () => json(503, {}) });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    const error = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([error.status, error.code]).toEqual([502, "provider"]);
  });

  it("answers 503 when the vault has no key", async () => {
    const error = await refusal(finishConnect({ state: "s", code: "c" }, deps(authServer(), { kms: null })));
    expect([error.status, error.code]).toEqual([503, "vault"]);
  });

  it("answers 502 and sends nothing when the metadata's token endpoint is a private address", async () => {
    // Discovery takes the metadata as written. The guard stops the exchange.
    const fetch = authServer({ metadata: { token_endpoint: "https://127.0.0.1/token" } });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    const error = await refusal(finishConnect({ state: started.state, code: "code-1" }, deps(fetch)));
    expect([error.status, error.code]).toEqual([502, "provider"]);
    expect(fetch.sent.some((request) => request.url.includes("127.0.0.1"))).toBe(false);
    expect(store.tokenFor(KEY)).toBeUndefined();
  });
});

describe("a reconnect", () => {
  it("revokes the old grant when the new one goes through another client", async () => {
    await store.addOperatorToken({
      ...KEY,
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "old-client",
      clientSecret: "old-secret",
      revocationEndpoint: REVOKE_URL,
    });
    const fetch = authServer();
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    await finishConnect({ state: started.state, code: "code-1" }, deps(fetch));

    const revoked = sentTo(fetch, REVOKE_URL);
    expect(revoked.map((request) => request.form?.get("token"))).toEqual(["old-rt", "old-at"]);
    expect(basicClient(revoked[0]?.headers.authorization)).toEqual({
      clientId: "old-client",
      clientSecret: "old-secret",
    });
    expect(store.tokens.size).toBe(1);
    expect(store.tokenFor(KEY)?.clientId).toBe("registered-1");
    expect((await store.openToken(store.tokenFor(KEY)?.id ?? "")).accessToken).toBe("op-at");
  });

  it("leaves the old grant alone when the same client connects again", async () => {
    await store.addOperatorToken({
      ...KEY,
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "registered-1",
      revocationEndpoint: REVOKE_URL,
    });
    const fetch = authServer();
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    await finishConnect({ state: started.state, code: "code-1" }, deps(fetch));
    expect(sentTo(fetch, REVOKE_URL)).toHaveLength(0);
  });

  it("keeps the new token when revoking the old grant fails", async () => {
    await store.addOperatorToken({
      ...KEY,
      accessToken: "old-at",
      clientId: "old-client",
      revocationEndpoint: REVOKE_URL,
    });
    const fetch = authServer({ revoke: () => json(503, {}) });
    const started = await beginConnect({ ...TARGET, redirectUri: REDIRECT }, deps(fetch));
    await expect(finishConnect({ state: started.state, code: "code-1" }, deps(fetch))).resolves.toMatchObject(TARGET);
    expect(store.tokenFor(KEY)?.clientId).toBe("registered-1");
  });
});

describe("disconnect", () => {
  it("revokes the operator's token at the server, deletes it, and answers false the second time", async () => {
    await store.addOperatorToken({
      ...KEY,
      accessToken: "op-at",
      refreshToken: "op-rt",
      clientSecret: "cs",
      revocationEndpoint: REVOKE_URL,
    });
    const other = await store.addOperatorToken({ ...KEY, userId: randomUUID(), accessToken: "other-at" });
    const fetch = authServer();

    expect(await disconnect(TARGET, deps(fetch))).toBe(true);
    expect(sentTo(fetch, REVOKE_URL).map((request) => request.form?.get("token_type_hint"))).toEqual([
      "refresh_token",
      "access_token",
    ]);
    expect(store.tokenFor(KEY)).toBeUndefined();
    expect(store.tokens.has(other.id)).toBe(true);

    expect(await disconnect(TARGET, deps(fetch))).toBe(false);
  });

  it("deletes the token even when the authorization server is down", async () => {
    await store.addOperatorToken({ ...KEY, accessToken: "op-at", revocationEndpoint: REVOKE_URL });
    const fetch = authServer({ revoke: () => json(503, {}) });
    expect(await disconnect(TARGET, deps(fetch))).toBe(true);
    expect(store.tokenFor(KEY)).toBeUndefined();
  });
});

describe("the connect link", () => {
  it("points at the API's connect route with the server and environment", () => {
    expect(
      mcpStudioConnectLink({
        apiBaseUrl: "https://api.example.com/",
        orgSlug: "acme co",
        workspaceSlug: "tools",
        server: "billing",
        environment: "sandbox",
      }),
    ).toBe("https://api.example.com/v1/acme%20co/tools/mcp-studio/oauth/connect?server=billing&environment=sandbox");
  });

  it("is what a workspace's credential source answers for an operator with no token", async () => {
    const source = await workspaceCredentialSource(
      { ...SCOPE, apiBaseUrl: "https://api.example.com", orgSlug: "acme", workspaceSlug: "tools" },
      { store: () => store, servers: () => Promise.resolve(servers), fetch: authServer(), now: () => clock, kms },
    );
    const resolved = await source.resolve(
      { server: "billing", environment: "sandbox", reference: undefined, auth: operatorOauth, operator: USER },
      new AbortController().signal,
    );
    expect(resolved).toEqual({
      type: "missing",
      message: "Connect your Billing API account in Oxagen, then retry.",
      connect_url: "https://api.example.com/v1/acme/tools/mcp-studio/oauth/connect?server=billing&environment=sandbox",
    });
  });
});
