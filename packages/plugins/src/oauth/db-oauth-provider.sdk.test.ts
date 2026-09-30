/**
 * The MCP SDK's own `auth()` driven through DbOAuthClientProvider against an
 * authorization server that binds each client to the token endpoint auth
 * method it registered with, as Linear's does.
 *
 * Linear's MCP server grants dynamic registration with
 * `client_secret_post` and answers a token request that authenticates with
 * HTTP Basic instead with `invalid_client`. The provider used to hand the SDK
 * a stored client with no method, the SDK then chose Basic, and every sign-in
 * to Linear from the Add a provider wizard failed at the callback. The
 * metadata below is what `https://mcp.linear.app` served on 2026-09-30.
 */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = {
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  oauthClientAuthMethod: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};
const credStore = new Map<string, Stored>();

vi.mock("../credentials/workspace-credential", () => ({
  setWorkspaceSecret: async (
    input: Partial<Stored> & { workspaceId: string; orgListingId: string },
  ) => {
    const key = `${input.workspaceId}:${input.orgListingId}`;
    const prev = credStore.get(key) ?? {
      oauthClientId: null,
      oauthClientSecret: null,
      oauthClientAuthMethod: null,
      accessToken: null,
      refreshToken: null,
    };
    // The real store's partial update: an absent key keeps its value.
    const next = { ...prev };
    for (const field of Object.keys(prev) as (keyof Stored)[]) {
      if (input[field] !== undefined) next[field] = input[field] ?? null;
    }
    credStore.set(key, next);
    return "cred-id";
  },
  getWorkspaceSecret: async (key: {
    workspaceId: string;
    orgListingId: string;
  }) => {
    const stored = credStore.get(`${key.workspaceId}:${key.orgListingId}`);
    return stored === undefined
      ? null
      : { ...stored, secret: null, authKind: "oauth", status: "active" };
  },
}));

const stateStore = new Map<string, unknown>();
vi.mock("./state-store", () => ({
  saveOAuthState: async (state: string, data: unknown) => {
    stateStore.set(state, data);
  },
  loadOAuthState: async (state: string) => stateStore.get(state) ?? null,
  deleteOAuthState: async (state: string) => {
    stateStore.delete(state);
  },
}));

const SERVER_URL = "https://mcp.linear.app/mcp";
const REDIRECT_URL = "https://oxagen.app/api/v1/mcp/oauth/callback";

const PROTECTED_RESOURCE = {
  resource: "https://mcp.linear.app/mcp",
  authorization_servers: ["https://mcp.linear.app"],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
};

const AUTHORIZATION_SERVER = {
  issuer: "https://mcp.linear.app",
  authorization_endpoint: "https://mcp.linear.app/authorize",
  token_endpoint: "https://mcp.linear.app/token",
  registration_endpoint: "https://mcp.linear.app/register",
  scopes_supported: ["read", "write", "openid", "email"],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ],
  code_challenge_methods_supported: ["S256"],
};

type TokenCall = { grantType: string | null; authorization: string | null };

const CLIENT_METADATA_URL =
  "https://oxagen.app/api/v1/mcp/oauth/client-metadata";

/**
 * A Linear-shaped authorization server. A client is bound to the method it
 * registered with; a token request that authenticates any other way is
 * refused with invalid_client, which is what Linear answers. With
 * `metadataDocumentOnly` it registers no clients and takes Oxagen's client
 * metadata document URL as a public client ID instead.
 */
function linear(options: { metadataDocumentOnly?: boolean } = {}) {
  const clients = new Map<string, { secret: string | null; method: string }>();
  if (options.metadataDocumentOnly === true) {
    clients.set(CLIENT_METADATA_URL, { secret: null, method: "none" });
  }
  const tokenCalls: TokenCall[] = [];
  let issued = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, PROTECTED_RESOURCE);
    }
    if (path === "/.well-known/oauth-authorization-server") {
      if (options.metadataDocumentOnly !== true) {
        return json(200, AUTHORIZATION_SERVER);
      }
      return json(200, {
        ...AUTHORIZATION_SERVER,
        registration_endpoint: undefined,
        client_id_metadata_document_supported: true,
      });
    }
    if (
      path === "/register" &&
      init?.method === "POST" &&
      options.metadataDocumentOnly !== true
    ) {
      const asked = JSON.parse(String(init.body)) as Record<string, unknown>;
      const method = String(
        asked.token_endpoint_auth_method ?? "client_secret_basic",
      );
      const id = `client-${clients.size + 1}`;
      clients.set(id, { secret: `secret-${id}`, method });
      return json(201, {
        ...asked,
        client_id: id,
        client_secret: `secret-${id}`,
        token_endpoint_auth_method: method,
      });
    }
    if (path === "/token" && init?.method === "POST") {
      const headers = new Headers(init.headers);
      const body = new URLSearchParams(String(init.body));
      const authorization = headers.get("authorization");
      tokenCalls.push({ grantType: body.get("grant_type"), authorization });
      let clientId: string | null;
      let secret: string | null;
      let method: string;
      if (authorization?.startsWith("Basic ")) {
        const [id, pw] = Buffer.from(authorization.slice(6), "base64")
          .toString()
          .split(":");
        clientId = decodeURIComponent(id ?? "");
        secret = decodeURIComponent(pw ?? "");
        method = "client_secret_basic";
      } else {
        clientId = body.get("client_id");
        secret = body.get("client_secret");
        method = secret === null ? "none" : "client_secret_post";
      }
      const client = clientId === null ? undefined : clients.get(clientId);
      if (
        client === undefined ||
        client.method !== method ||
        client.secret !== secret
      ) {
        return json(401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
      }
      issued += 1;
      return json(200, {
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, tokenCalls };
}

const scope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  orgListingId: "listing-linear",
};

async function providerFor(
  state: string,
  extra: { clientMetadataUrl?: string } = {},
) {
  const { DbOAuthClientProvider } = await import("./db-oauth-provider");
  return new DbOAuthClientProvider({
    ...extra,
    ...scope,
    redirectUrl: REDIRECT_URL,
    state,
    returnTo: "",
    clientName: "Oxagen",
    now: () => 1_790_000_000_000,
    serverUrl: SERVER_URL,
  });
}

beforeEach(() => {
  credStore.clear();
  stateStore.clear();
  vi.resetModules();
});

describe("DbOAuthClientProvider through the SDK against a method-bound server", () => {
  it("signs in to Linear: registers, redirects, exchanges the code and refreshes", async () => {
    const server = linear();

    // start_mcp_authorization: registration, then the sign-in URL.
    const starting = await providerFor("state-linear-0001");
    await expect(
      auth(starting, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }),
    ).resolves.toBe("REDIRECT");
    const signIn = starting.pendingRedirect;
    expect(signIn?.origin).toBe("https://mcp.linear.app");
    expect(signIn?.searchParams.get("client_id")).toBe("client-1");
    expect(signIn?.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);

    // authorize_mcp_server: the callback's fresh provider exchanges the code.
    const completing = await providerFor("state-linear-0001");
    await expect(
      auth(completing, {
        serverUrl: SERVER_URL,
        authorizationCode: "code-from-linear",
        fetchFn: server.fetchFn,
      }),
    ).resolves.toBe("AUTHORIZED");
    expect(server.tokenCalls).toEqual([
      { grantType: "authorization_code", authorization: null },
    ]);
    expect(credStore.get("ws-1:listing-linear")).toMatchObject({
      oauthClientId: "client-1",
      oauthClientAuthMethod: "client_secret_post",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });

    // The runtime's provider renews the token with the same client method.
    const runtime = await providerFor("runtime:listing-linear");
    await expect(
      auth(runtime, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }),
    ).resolves.toBe("AUTHORIZED");
    expect(server.tokenCalls[1]).toEqual({
      grantType: "refresh_token",
      authorization: null,
    });
    expect(credStore.get("ws-1:listing-linear")?.accessToken).toBe("access-2");
  });

  it("exchanges a code for a client registered before the method was recorded", async () => {
    const server = linear();
    const starting = await providerFor("state-legacy-0001");
    await auth(starting, { serverUrl: SERVER_URL, fetchFn: server.fetchFn });
    // A row written before migration 20260930120000 holds no method.
    const row = credStore.get("ws-1:listing-linear");
    if (row === undefined) throw new Error("registration stored no client");
    credStore.set("ws-1:listing-linear", {
      ...row,
      oauthClientAuthMethod: null,
    });

    const completing = await providerFor("state-legacy-0001");
    await expect(
      auth(completing, {
        serverUrl: SERVER_URL,
        authorizationCode: "code-from-linear",
        fetchFn: server.fetchFn,
      }),
    ).resolves.toBe("AUTHORIZED");
    expect(server.tokenCalls).toEqual([
      { grantType: "authorization_code", authorization: null },
    ]);
  });

  it("signs in with the client metadata document at a server that registers no clients", async () => {
    const server = linear({ metadataDocumentOnly: true });

    const starting = await providerFor("state-cimd-0001", {
      clientMetadataUrl: CLIENT_METADATA_URL,
    });
    await expect(
      auth(starting, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }),
    ).resolves.toBe("REDIRECT");
    expect(starting.pendingRedirect?.searchParams.get("client_id")).toBe(
      CLIENT_METADATA_URL,
    );
    expect(credStore.get("ws-1:listing-linear")).toMatchObject({
      oauthClientId: CLIENT_METADATA_URL,
      oauthClientSecret: null,
      oauthClientAuthMethod: "none",
    });

    // The callback's provider carries no metadata URL: the stored client ID is
    // what it presents.
    const completing = await providerFor("state-cimd-0001");
    await expect(
      auth(completing, {
        serverUrl: SERVER_URL,
        authorizationCode: "code-from-server",
        fetchFn: server.fetchFn,
      }),
    ).resolves.toBe("AUTHORIZED");
    expect(server.tokenCalls).toEqual([
      { grantType: "authorization_code", authorization: null },
    ]);
    expect(credStore.get("ws-1:listing-linear")?.accessToken).toBe("access-1");
  });
});
