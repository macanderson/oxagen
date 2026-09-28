/**
 * The OAuth 2.0 client behind MCP Studio credentials. A fake fetch stands in
 * for the authorization server, so these tests check each request Oxagen
 * sends, how it reads each answer, and that no error message quotes a token
 * or a client secret.
 */
import { createHash } from "node:crypto";
import { UnsafeOutboundUrlError } from "@oxagen/config/public-url";
import type { SecurityScheme } from "@oxagen/mcp-studio";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  authorizationCodeGrant,
  authorizationUrl,
  clientCredentialsGrant,
  discoverAuthorizationServer,
  type FetchLike,
  type OAuthClient,
  OAuthRefusedError,
  OAuthUnavailableError,
  pkcePair,
  refreshGrant,
  registerClient,
  revokeToken,
} from "./oauth";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ISSUER = "https://auth.example.com";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const REVOKE_URL = `${ISSUER}/oauth/revoke`;
const REGISTER_URL = `${ISSUER}/oauth/register`;
const REDIRECT_URI = "https://api.oxagen.test/oauth/mcp-studio/callback";
const NOW = new Date("2026-09-28T12:00:00.000Z");

const SECRET = "client-secret-value";
const CLIENT: OAuthClient = { clientId: "client-1", clientSecret: SECRET };
const PUBLIC_CLIENT: OAuthClient = { clientId: "client-1", clientSecret: null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(...answers: Response[]): Mock<FetchLike> {
  const fetch = vi.fn<FetchLike>();
  for (const answer of answers) fetch.mockResolvedValueOnce(answer);
  return fetch;
}

/** A fetch that answers by URL, and 404 for every URL the table leaves out. */
function routedFetch(table: Record<string, () => Response>): Mock<FetchLike> {
  return vi.fn<FetchLike>((url) => {
    const answer = table[url];
    return Promise.resolve(answer === undefined ? new Response(null, { status: 404 }) : answer());
  });
}

function options(fetch: FetchLike, signal: AbortSignal = new AbortController().signal) {
  return { fetch, signal, now: NOW };
}

function call(fetch: Mock<FetchLike>, index = 0): { url: string; init: RequestInit } {
  const found = fetch.mock.calls[index];
  if (found === undefined) throw new Error(`fetch was not called ${index + 1} times`);
  const [url, init] = found;
  return { url, init };
}

function bodyText(init: RequestInit): string {
  if (typeof init.body !== "string") throw new Error("the request body is not a string");
  return init.body;
}

function form(init: RequestInit): URLSearchParams {
  return new URLSearchParams(bodyText(init));
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/** RFC 6749 section 2.3.1: each half is form-encoded, then the pair is base64. */
function basic(clientId: string, clientSecret: string): string {
  const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`, "utf8").toString("base64")}`;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("the promise rejected with something that is not an Error");
  }
  throw new Error("the promise resolved");
}

function grant(fetch: FetchLike, client: OAuthClient = CLIENT) {
  return clientCredentialsGrant(
    { tokenEndpoint: TOKEN_URL, client, scopes: ["read", "write"] },
    options(fetch),
  );
}

// ── clientCredentialsGrant ───────────────────────────────────────────────────

describe("clientCredentialsGrant", () => {
  it("authenticates with HTTP Basic and sends the scopes", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1", token_type: "Bearer" }));

    await grant(fetch);

    const { url, init } = call(fetch);
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(header(init, "authorization")).toBe(basic("client-1", SECRET));
    expect(header(init, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(header(init, "accept")).toBe("application/json");
    const body = form(init);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("read write");
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
  });

  it("form-encodes the client id and secret before base64", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    await grant(fetch, { clientId: "id with space", clientSecret: "p@ss:word" });

    const expected = `Basic ${Buffer.from("id+with+space:p%40ss%3Aword").toString("base64")}`;
    expect(header(call(fetch).init, "authorization")).toBe(expected);
  });

  it("sends no scope when none is asked for", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    await clientCredentialsGrant({ tokenEndpoint: TOKEN_URL, client: CLIENT, scopes: [] }, options(fetch));

    expect(form(call(fetch).init).has("scope")).toBe(false);
  });

  it("turns expires_in into an expiry and splits the granted scopes", async () => {
    const fetch = fakeFetch(
      json(200, { access_token: "at-1", token_type: "bearer", expires_in: 3600, scope: "read  write" }),
    );

    await expect(grant(fetch)).resolves.toEqual({
      accessToken: "at-1",
      refreshToken: null,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      scopes: ["read", "write"],
    });
  });

  it("reads expires_in when the server sends it as a string", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1", expires_in: "120" }));

    const token = await grant(fetch);

    expect(token.expiresAt).toEqual(new Date(NOW.getTime() + 120_000));
  });

  it("answers null for the expiry and the scopes when the server sends neither", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    const token = await grant(fetch);

    expect(token.expiresAt).toBeNull();
    expect(token.scopes).toBeNull();
  });

  it("retries once with the secret in the body when Basic gets invalid_client", async () => {
    const fetch = fakeFetch(
      json(401, { error: "invalid_client" }),
      json(200, { access_token: "at-1", token_type: "Bearer" }),
    );

    const token = await grant(fetch);

    expect(token.accessToken).toBe("at-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    const retry = call(fetch, 1).init;
    expect(header(retry, "authorization")).toBeNull();
    const body = form(retry);
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe(SECRET);
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("throws the second refusal when the body retry is refused too", async () => {
    const fetch = fakeFetch(json(401, { error: "invalid_client" }), json(401, { error: "invalid_client" }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_client");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry after a refusal other than invalid_client", async () => {
    const fetch = fakeFetch(json(400, { error: "invalid_scope" }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_scope");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the server is unavailable", async () => {
    const fetch = fakeFetch(json(503, { error: "temporarily_unavailable" }));

    await expect(grant(fetch)).rejects.toBeInstanceOf(OAuthUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a public client's id in the body and no Authorization header", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    await grant(fetch, PUBLIC_CLIENT);

    const { init } = call(fetch);
    expect(header(init, "authorization")).toBeNull();
    expect(form(init).get("client_id")).toBe("client-1");
    expect(form(init).has("client_secret")).toBe(false);
  });

  it("does not retry a public client, which has no secret to move", async () => {
    const fetch = fakeFetch(json(401, { error: "invalid_client" }));

    const error = await caught(grant(fetch, PUBLIC_CLIENT));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── refreshGrant ─────────────────────────────────────────────────────────────

describe("refreshGrant", () => {
  function refresh(fetch: FetchLike) {
    return refreshGrant({ tokenEndpoint: TOKEN_URL, client: CLIENT, refreshToken: "rt-old" }, options(fetch));
  }

  it("sends the refresh token with the refresh grant", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-2" }));

    await refresh(fetch);

    const body = form(call(fetch).init);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
    expect(header(call(fetch).init, "authorization")).toBe(basic("client-1", SECRET));
  });

  it("answers a null refresh token when the server keeps the old one", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-2" }));

    const token = await refresh(fetch);

    expect(token.accessToken).toBe("at-2");
    expect(token.refreshToken).toBeNull();
  });

  it("answers the new refresh token when the server rotates it", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-2", refresh_token: "rt-new" }));

    const token = await refresh(fetch);

    expect(token.refreshToken).toBe("rt-new");
  });

  it("answers invalid_grant as a refusal", async () => {
    const fetch = fakeFetch(json(400, { error: "invalid_grant" }));

    const error = await caught(refresh(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_grant");
    expect(error.message).toBe(`The OAuth server at ${ISSUER} refused the request (invalid_grant).`);
  });
});

// ── authorizationCodeGrant ───────────────────────────────────────────────────

describe("authorizationCodeGrant", () => {
  function trade(fetch: FetchLike, resource: string | null) {
    return authorizationCodeGrant(
      {
        tokenEndpoint: TOKEN_URL,
        client: CLIENT,
        code: "code-1",
        redirectUri: REDIRECT_URI,
        codeVerifier: "verifier-1",
        resource,
      },
      options(fetch),
    );
  }

  it("sends the code, the redirect URI, the PKCE verifier, and the resource", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1", refresh_token: "rt-1" }));

    const token = await trade(fetch, "https://mcp.example.com/mcp");

    const body = form(call(fetch).init);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(token).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
  });

  it("sends no resource when the server named none", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    await trade(fetch, null);

    expect(form(call(fetch).init).has("resource")).toBe(false);
  });
});

// ── Token answers ────────────────────────────────────────────────────────────

describe("a token endpoint's answer", () => {
  it("is refused when the token type is not bearer", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1", token_type: "mac" }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("unsupported_token_type");
  });

  it("is unavailable when it carries no access token", async () => {
    const fetch = fakeFetch(json(200, { token_type: "Bearer" }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The OAuth server at ${ISSUER} answered without an access token.`);
  });

  it("is unavailable when expires_in is negative", async () => {
    const fetch = fakeFetch(json(200, { access_token: "at-1", expires_in: -1 }));

    await expect(grant(fetch)).rejects.toBeInstanceOf(OAuthUnavailableError);
  });

  it("is unavailable when the body is not JSON", async () => {
    const fetch = fakeFetch(new Response("<html>ok</html>", { status: 200 }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The OAuth server at ${ISSUER} answered with a body that is not JSON.`);
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe("a request that fails", () => {
  it("is refused with code redirect when the server answers 3xx", async () => {
    const fetch = fakeFetch(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/token" } }),
    );

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("redirect");
    expect(error.message).toContain("answered 302 with a redirect");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is refused with the HTTP status when a 4xx body names no error", async () => {
    const fetch = fakeFetch(new Response("forbidden", { status: 403 }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("http_403");
  });

  it.each([408, 429, 500, 502, 503])("is unavailable when the server answers %i", async (status) => {
    const fetch = fakeFetch(json(status, { error: "slow_down" }));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The OAuth server at ${ISSUER} answered ${status}.`);
  });

  it("is unavailable when the network fails", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new TypeError("fetch failed"));

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The OAuth server at ${ISSUER} could not be reached: fetch failed.`);
  });

  it("is unavailable when fetch rejects with something that is not an Error", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue("offline");

    const error = await caught(grant(fetch));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toContain("could not be reached: the request failed.");
  });

  it("is unavailable when the server does not answer before the deadline", async () => {
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const error = await caught(
      clientCredentialsGrant(
        { tokenEndpoint: TOKEN_URL, client: CLIENT, scopes: [] },
        { ...options(fetch), timeoutMs: 20 },
      ),
    );

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The OAuth server at ${ISSUER} could not be reached: it did not answer within 20 ms.`);
  });

  it("passes the caller's abort reason through unchanged", async () => {
    const reason = new Error("the run was cancelled");
    const fetch = vi.fn<FetchLike>((_url, init) =>
      init.signal?.aborted === true ? Promise.reject(new Error("aborted")) : Promise.resolve(json(200, {})),
    );

    const error = await caught(
      clientCredentialsGrant(
        { tokenEndpoint: TOKEN_URL, client: CLIENT, scopes: [] },
        options(fetch, AbortSignal.abort(reason)),
      ),
    );

    expect(error).toBe(reason);
  });

  it.each([
    ["plain http", "http://auth.example.com/oauth/token"],
    ["a private address", "https://10.0.0.5/oauth/token"],
    ["localhost", "https://localhost/oauth/token"],
  ])("refuses a token endpoint at %s without calling it", async (_label, tokenEndpoint) => {
    const fetch = fakeFetch(json(200, { access_token: "at-1" }));

    const error = await caught(
      clientCredentialsGrant({ tokenEndpoint, client: CLIENT, scopes: [] }, options(fetch)),
    );

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── No secret in a message ───────────────────────────────────────────────────

describe("an error message", () => {
  it("quotes no client secret, token, or error description", async () => {
    const leaks = [SECRET, "rt-secret-value", "at-secret-value", "hunter2pass"];
    const errors = [
      await caught(
        refreshGrant(
          { tokenEndpoint: TOKEN_URL, client: CLIENT, refreshToken: "rt-secret-value" },
          options(
            fakeFetch(
              json(400, { error: "invalid_grant", error_description: "rt-secret-value was revoked" }),
            ),
          ),
        ),
      ),
      await caught(
        refreshGrant(
          { tokenEndpoint: TOKEN_URL, client: CLIENT, refreshToken: "rt-secret-value" },
          options(fakeFetch(json(200, { access_token: "at-secret-value", token_type: "mac" }))),
        ),
      ),
      await caught(
        grant(fakeFetch(json(401, { error: "invalid_client" }), json(500, { client_secret: SECRET }))),
      ),
      await caught(
        grant(vi.fn<FetchLike>().mockRejectedValue(new TypeError("fetch failed"))),
      ),
      await caught(
        clientCredentialsGrant(
          { tokenEndpoint: "https://user:hunter2pass@auth.example.com/token", client: CLIENT, scopes: [] },
          options(fakeFetch()),
        ),
      ),
      await caught(
        registerClient(
          { registrationEndpoint: REGISTER_URL, redirectUri: REDIRECT_URI, scopes: [] },
          options(fakeFetch(json(201, { client_secret: "at-secret-value" }))),
        ),
      ),
    ];

    for (const error of errors) {
      for (const leak of leaks) expect(error.message).not.toContain(leak);
    }
  });
});

// ── revokeToken ──────────────────────────────────────────────────────────────

describe("revokeToken", () => {
  function revoke(fetch: FetchLike, signal?: AbortSignal, revocationEndpoint = REVOKE_URL) {
    return revokeToken(
      { revocationEndpoint, client: CLIENT, token: "rt-1", hint: "refresh_token" },
      options(fetch, signal),
    );
  }

  it("posts the token and its hint with HTTP Basic and answers true when accepted", async () => {
    const fetch = fakeFetch(new Response(null, { status: 200 }));

    await expect(revoke(fetch)).resolves.toBe(true);

    const { url, init } = call(fetch);
    expect(url).toBe(REVOKE_URL);
    expect(header(init, "authorization")).toBe(basic("client-1", SECRET));
    const body = form(init);
    expect(body.get("token")).toBe("rt-1");
    expect(body.get("token_type_hint")).toBe("refresh_token");
  });

  it("answers false when the server refuses", async () => {
    await expect(revoke(fakeFetch(json(400, { error: "unsupported_token_type" })))).resolves.toBe(false);
  });

  it("answers false when the network fails", async () => {
    await expect(revoke(vi.fn<FetchLike>().mockRejectedValue(new TypeError("fetch failed")))).resolves.toBe(false);
  });

  it("answers false for an unsafe URL without calling it", async () => {
    const fetch = fakeFetch();

    await expect(revoke(fetch, undefined, "http://auth.example.com/oauth/revoke")).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the caller's abort reason through", async () => {
    const reason = new Error("the run was cancelled");
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error("aborted"));

    const error = await caught(revoke(fetch, AbortSignal.abort(reason)));

    expect(error).toBe(reason);
  });
});

// ── PKCE and the authorization URL ───────────────────────────────────────────

describe("pkcePair", () => {
  it("makes a verifier RFC 7636 allows and its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("makes a new verifier each time", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe("authorizationUrl", () => {
  const INPUT = {
    authorizationEndpoint: AUTHORIZE_URL,
    clientId: "client-1",
    redirectUri: REDIRECT_URI,
    state: "state-1",
    codeChallenge: "challenge-1",
    scopes: ["read", "write"],
    resource: "https://mcp.example.com/mcp",
  };

  it("sets the code flow, PKCE, state, scope, and resource parameters", () => {
    const url = new URL(authorizationUrl(INPUT));

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: REDIRECT_URI,
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      scope: "read write",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("leaves out scope and resource when there are none", () => {
    const url = new URL(authorizationUrl({ ...INPUT, scopes: [], resource: null }));

    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("keeps a query the authorization endpoint already carries", () => {
    const url = new URL(authorizationUrl({ ...INPUT, authorizationEndpoint: `${AUTHORIZE_URL}?prompt=consent` }));

    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

// ── discoverAuthorizationServer ──────────────────────────────────────────────

describe("discoverAuthorizationServer", () => {
  const OAUTH2: SecurityScheme = { type: "oauth2" };
  const SERVER_URL = "https://mcp.example.com/mcp/";
  const METADATA = {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    revocation_endpoint: REVOKE_URL,
    registration_endpoint: REGISTER_URL,
  };
  const FOUND = {
    authorizationEndpoint: AUTHORIZE_URL,
    tokenEndpoint: TOKEN_URL,
    refreshEndpoint: TOKEN_URL,
    revocationEndpoint: REVOKE_URL,
    registrationEndpoint: REGISTER_URL,
  };

  function discover(fetch: FetchLike, apply: SecurityScheme, serverUrl: string | undefined = SERVER_URL) {
    return discoverAuthorizationServer({ apply, serverUrl }, options(fetch));
  }

  it("uses the scheme's own URLs without a request", async () => {
    const fetch = fakeFetch();

    const found = await discover(fetch, {
      type: "oauth2",
      authorization_url: AUTHORIZE_URL,
      token_url: TOKEN_URL,
      refresh_url: `${ISSUER}/oauth/refresh`,
    });

    expect(found).toEqual({
      authorizationEndpoint: AUTHORIZE_URL,
      tokenEndpoint: TOKEN_URL,
      refreshEndpoint: `${ISSUER}/oauth/refresh`,
      revocationEndpoint: null,
      registrationEndpoint: null,
      resource: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes at the token URL when the scheme names no refresh URL", async () => {
    const found = await discover(fakeFetch(), { type: "oauth2", token_url: TOKEN_URL });

    expect(found.refreshEndpoint).toBe(TOKEN_URL);
    expect(found.authorizationEndpoint).toBeNull();
  });

  it("reads the scheme's OpenID Connect document", async () => {
    const oidc = `${ISSUER}/.well-known/openid-configuration`;
    const fetch = routedFetch({ [oidc]: () => json(200, METADATA) });

    const found = await discover(fetch, { type: "openIdConnect", openid_connect_url: oidc });

    expect(found).toEqual({ ...FOUND, resource: null });
    const { url, init } = call(fetch);
    expect(url).toBe(oidc);
    expect(init.method).toBe("GET");
    expect(header(init, "accept")).toBe("application/json");
  });

  it("refuses when the OpenID Connect document is not found", async () => {
    const error = await caught(
      discover(routedFetch({}), {
        type: "openIdConnect",
        openid_connect_url: `${ISSUER}/.well-known/openid-configuration`,
      }),
    );

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_metadata");
    expect(error.message).toContain("was not found");
  });

  it("refuses metadata that names no token endpoint", async () => {
    const oidc = `${ISSUER}/.well-known/openid-configuration`;
    const fetch = routedFetch({ [oidc]: () => json(200, { issuer: ISSUER }) });

    const error = await caught(discover(fetch, { type: "openIdConnect", openid_connect_url: oidc }));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect(error.message).toBe(`The authorization server metadata at ${ISSUER} names no token endpoint.`);
  });

  it("refuses a scheme with no URL when the environment has no URL either", async () => {
    const fetch = fakeFetch();

    const error = await caught(
      discoverAuthorizationServer({ apply: OAUTH2, serverUrl: undefined }, options(fetch)),
    );

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_metadata");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows RFC 9728 resource metadata to the issuer's RFC 8414 metadata", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json(200, {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: [`${ISSUER}/tenant`],
        }),
      [`${ISSUER}/.well-known/oauth-authorization-server/tenant`]: () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found).toEqual({ ...FOUND, resource: "https://mcp.example.com/mcp" });
  });

  it("names the server URL as the resource when the RFC 9728 document names none", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json(200, { authorization_servers: [ISSUER] }),
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found.resource).toBe(SERVER_URL);
  });

  it("tries OpenID Connect discovery at the issuer after RFC 8414", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json(200, { authorization_servers: [ISSUER] }),
      [`${ISSUER}/.well-known/openid-configuration`]: () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found.tokenEndpoint).toBe(TOKEN_URL);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      `${ISSUER}/.well-known/oauth-authorization-server`,
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
  });

  it("falls back to RFC 8414 metadata at the server's origin with no resource", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-authorization-server": () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found).toEqual({ ...FOUND, resource: null });
  });

  it("falls back to the server's origin when the RFC 9728 document names no authorization server", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json(200, { authorization_servers: [] }),
      "https://mcp.example.com/.well-known/oauth-authorization-server": () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found.resource).toBeNull();
    expect(found.tokenEndpoint).toBe(TOKEN_URL);
  });

  it("falls back to the server's origin when the named issuer publishes no metadata", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json(200, { authorization_servers: [ISSUER] }),
      "https://mcp.example.com/.well-known/openid-configuration": () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2);

    expect(found).toEqual({ ...FOUND, resource: null });
  });

  it("reads a server URL with no path from the bare well-known URL", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": () =>
        json(200, { authorization_servers: [ISSUER] }),
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () => json(200, METADATA),
    });

    const found = await discover(fetch, OAUTH2, "https://mcp.example.com/");

    expect(found.resource).toBe("https://mcp.example.com/");
  });

  it("refuses when no metadata is found anywhere", async () => {
    const error = await caught(discover(routedFetch({}), OAUTH2));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_metadata");
    expect(error.message).toBe("No OAuth metadata was found for https://mcp.example.com.");
  });

  it("is unavailable when a metadata document is not JSON", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        new Response("<html></html>", { status: 200 }),
    });

    const error = await caught(discover(fetch, OAUTH2));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe("The metadata at https://mcp.example.com is not JSON.");
  });

  it("is unavailable when a metadata request answers 5xx", async () => {
    const fetch = routedFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () => json(500, {}),
    });

    await expect(discover(fetch, OAUTH2)).rejects.toBeInstanceOf(OAuthUnavailableError);
  });

  it("refuses an OpenID Connect URL at a private address without calling it", async () => {
    const fetch = fakeFetch();

    const error = await caught(
      discover(fetch, {
        type: "openIdConnect",
        openid_connect_url: "https://169.254.169.254/.well-known/openid-configuration",
      }),
    );

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a server URL that is not https without calling it", async () => {
    const fetch = fakeFetch();

    const error = await caught(discover(fetch, OAUTH2, "http://mcp.example.com/mcp"));

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── registerClient ───────────────────────────────────────────────────────────

describe("registerClient", () => {
  function register(fetch: FetchLike, scopes: string[] = ["read", "write"]) {
    return registerClient({ registrationEndpoint: REGISTER_URL, redirectUri: REDIRECT_URI, scopes }, options(fetch));
  }

  it("registers Oxagen for the code flow and answers the issued client", async () => {
    const fetch = fakeFetch(json(201, { client_id: "registered-1", client_secret: "registered-secret" }));

    const client = await register(fetch);

    expect(client).toEqual({ clientId: "registered-1", clientSecret: "registered-secret" });
    const { url, init } = call(fetch);
    expect(url).toBe(REGISTER_URL);
    expect(init.method).toBe("POST");
    expect(header(init, "content-type")).toBe("application/json");
    expect(JSON.parse(bodyText(init))).toEqual({
      client_name: "Oxagen",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scope: "read write",
    });
  });

  it("sends no scope when none is asked for, and answers a public client without a secret", async () => {
    const fetch = fakeFetch(json(201, { client_id: "registered-1" }));

    const client = await register(fetch, []);

    expect(client).toEqual({ clientId: "registered-1", clientSecret: null });
    expect(JSON.parse(bodyText(call(fetch).init))).not.toHaveProperty("scope");
  });

  it("is unavailable when the answer names no client id", async () => {
    const error = await caught(register(fakeFetch(json(201, { client_secret: "registered-secret" }))));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
    expect(error.message).toBe(`The registration endpoint at ${ISSUER} answered without a client id.`);
    expect(error.message).not.toContain("registered-secret");
  });

  it("is unavailable when the answer is not JSON", async () => {
    const error = await caught(register(fakeFetch(new Response("created", { status: 201 }))));

    expect(error).toBeInstanceOf(OAuthUnavailableError);
  });

  it("answers a refusal with the server's error code", async () => {
    const error = await caught(register(fakeFetch(json(400, { error: "invalid_redirect_uri" }))));

    expect(error).toBeInstanceOf(OAuthRefusedError);
    expect((error as OAuthRefusedError).code).toBe("invalid_redirect_uri");
  });
});
