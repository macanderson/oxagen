import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  discover: vi.fn(),
  detect: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  resolve: vi.fn(),
  prereg: vi.fn(),
  loadState: vi.fn(),
  deleteState: vi.fn(),
  healthcheck: vi.fn(),
  snapshots: vi.fn(),
  change: vi.fn(),
  steeringWriter: vi.fn(),
  addServer: vi.fn(),
  rows: [] as unknown[][],
  inserts: [] as { values: unknown; set: unknown; doNothing: boolean }[],
  updates: [] as { set: unknown }[],
  /** What each update's RETURNING yields, in order; one row when empty. */
  updateResults: [] as unknown[][],
  pendingRedirect: null as URL | null,
  /** What the provider holds after `auth()` ran: a client, or none. */
  clientInfo: { client_id: "x" } as { client_id: string } | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: m.auth,
  discoverOAuthServerInfo: m.discover,
}));

vi.mock("@oxagen/plugins", () => ({
  DbOAuthClientProvider: class {
    constructor(readonly ctx: unknown) {}
    get pendingRedirect() {
      return m.pendingRedirect;
    }
    clientInformation() {
      return Promise.resolve(m.clientInfo);
    }
  },
  getWorkspaceSecret: m.getSecret,
  setWorkspaceSecret: m.setSecret,
  preregisteredClientForEndpoint: m.prereg,
  resolveEndpointRedirects: m.resolve,
  loadOAuthState: m.loadState,
  deleteOAuthState: m.deleteState,
}));

vi.mock("./mcp-auth-probe", () => ({ probeMcpAuth: m.detect }));
vi.mock("../dispatch/mcp-client", () => ({ healthcheck: m.healthcheck }));
vi.mock("./mcp-snapshots", () => ({
  captureToolSnapshots: m.snapshots,
  recordServerChange: m.change,
}));
vi.mock("./steering-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./steering-pr")>()),
  steeringWriter: m.steeringWriter,
}));

// A query builder that answers every select with the next queued row set and
// records every insert and update.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const select = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => m.rows.shift() ?? [],
    };
    return chain;
  };
  const insert = () => {
    const rec = {
      values: undefined as unknown,
      set: undefined as unknown,
      doNothing: false,
    };
    const chain = {
      values: (v: unknown) => {
        rec.values = v;
        return chain;
      },
      onConflictDoUpdate: (o: { set: unknown }) => {
        rec.set = o.set;
        return chain;
      },
      onConflictDoNothing: () => {
        rec.doNothing = true;
        return chain;
      },
      returning: async () => {
        m.inserts.push(rec);
        return [{ id: "row-uuid", publicId: "mcs_new" }];
      },
    };
    return chain;
  };
  const update = () => {
    const rec = { set: undefined as unknown };
    m.updates.push(rec);
    const result = () => m.updateResults.shift() ?? [{ id: "row-uuid" }];
    const chain = {
      set: (v: unknown) => {
        rec.set = v;
        return chain;
      },
      where: () => chain,
      returning: async () => result(),
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, fail),
    };
    return chain;
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({ select, insert, update }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  assertRedirectUrl,
  clientMetadataUrlFor,
  completeMcpAuthorization,
  listingKeyOf,
  startMcpAuthorization,
} from "./mcp-oauth-flow";

const SCOPE = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };
const REDIRECT = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";
const STEERING_PR = {
  number: 12,
  url: "https://github.com/acme/steering/pull/12",
  branch: "tools/add-server-linear-20261001t120000z",
};
const fetchFn = vi.fn() as unknown as typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.inserts = [];
  m.updates = [];
  m.updateResults = [];
  m.steeringWriter.mockResolvedValue(null);
  m.addServer.mockResolvedValue(STEERING_PR);
  m.pendingRedirect = null;
  m.clientInfo = { client_id: "x" };
  m.detect.mockResolvedValue("oauth");
  m.getSecret.mockResolvedValue(null);
  m.resolve.mockImplementation(async (url: string) => url);
  m.prereg.mockReturnValue(undefined);
  m.deleteState.mockResolvedValue(undefined);
  m.healthcheck.mockResolvedValue({
    status: "healthy",
    discoveredTools: ["list_issues"],
    descriptors: [{ name: "list_issues" }],
  });
  m.snapshots.mockResolvedValue(undefined);
  m.change.mockResolvedValue(undefined);
});

describe("assertRedirectUrl", () => {
  it("accepts the app callback over https, or http on localhost", () => {
    expect(assertRedirectUrl(REDIRECT)).toBe(REDIRECT);
    expect(
      assertRedirectUrl("http://localhost:3000/api/v1/mcp/oauth/callback"),
    ).toContain("localhost");
  });

  it("refuses any other path, scheme or a query", () => {
    for (const bad of [
      "https://app.oxagen.sh/elsewhere",
      "http://app.oxagen.sh/api/v1/mcp/oauth/callback",
      `${REDIRECT}?next=/x`,
      "not a url",
    ]) {
      expect(() => assertRedirectUrl(bad)).toThrow(
        expect.objectContaining({ reason: "redirect_url_invalid" }),
      );
    }
  });
});

describe("clientMetadataUrlFor", () => {
  it("names the document on an https callback's origin, and none on local http", () => {
    expect(clientMetadataUrlFor(REDIRECT)).toBe(
      "https://app.oxagen.sh/api/v1/mcp/oauth/client-metadata",
    );
    expect(
      clientMetadataUrlFor("http://localhost:3000/api/v1/mcp/oauth/callback"),
    ).toBeUndefined();
  });
});

describe("listingKeyOf", () => {
  it("keys a registry pick by its id and a custom server by its endpoint", () => {
    expect(listingKeyOf("verified/linear", "https://mcp.linear.app/mcp")).toBe(
      "verified/linear",
    );
    expect(listingKeyOf(undefined, "https://mcp.acme.dev/v1/mcp/")).toBe(
      "custom:mcp.acme.dev/v1/mcp",
    );
  });
});

describe("startMcpAuthorization", () => {
  const add = {
    name: "Linear",
    endpointUrl: "https://mcp.linear.app/mcp",
    registryId: "verified/linear",
    iconUrl: "https://linear.app/favicon.ico",
    redirectUrl: REDIRECT,
  };

  it("creates the OAuth listing and returns the sign-in URL for a server that registers clients", async () => {
    m.discover.mockResolvedValue({
      authorizationServerMetadata: {
        registration_endpoint: "https://mcp.linear.app/register",
      },
      resourceMetadata: { scopes_supported: ["read", "write"] },
    });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://mcp.linear.app/authorize?state=s1");
      return "REDIRECT";
    });
    const out = await startMcpAuthorization(SCOPE, add, {
      fetchFn,
      newState: () => "s1",
    });
    expect(out).toEqual({
      status: "redirect",
      authorizationUrl: "https://mcp.linear.app/authorize?state=s1",
      state: "s1",
    });
    expect(m.inserts[0]?.values).toMatchObject({
      pluginType: "mcp_server",
      source: "registry",
      name: "verified/linear",
      title: "Linear",
      authKind: "oauth",
      iconUrl: "https://linear.app/favicon.ico",
    });
    expect(m.setSecret).not.toHaveBeenCalled();
  });

  it("asks for the workspace's OAuth app when the server registers no clients (Slack)", async () => {
    m.discover.mockResolvedValue({
      authorizationServerMetadata: {},
      resourceMetadata: { scopes_supported: ["chat:write", "channels:read"] },
    });
    const out = await startMcpAuthorization(
      SCOPE,
      { ...add, name: "Slack", endpointUrl: "https://mcp.slack.com/mcp" },
      { fetchFn },
    );
    expect(out).toEqual({
      status: "client_required",
      scopesSupported: ["chat:write", "channels:read"],
    });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("signs in with the client metadata document at a server that registers no clients but takes one", async () => {
    m.discover.mockResolvedValue({
      authorizationServerMetadata: { client_id_metadata_document_supported: true },
      resourceMetadata: { scopes_supported: ["read"] },
    });
    const providers: unknown[] = [];
    m.auth.mockImplementation(async (provider: { ctx: unknown }) => {
      providers.push(provider.ctx);
      m.pendingRedirect = new URL("https://auth.example.dev/authorize?state=s4");
      return "REDIRECT";
    });
    const out = await startMcpAuthorization(
      SCOPE,
      { ...add, name: "Example", endpointUrl: "https://mcp.example.dev/mcp" },
      { fetchFn, newState: () => "s4" },
    );
    expect(out).toMatchObject({ status: "redirect", state: "s4" });
    expect(providers[0]).toMatchObject({
      clientMetadataUrl:
        "https://app.oxagen.sh/api/v1/mcp/oauth/client-metadata",
    });
  });

  it("asks for an OAuth app at a metadata-document server when the callback is local http", async () => {
    m.discover.mockResolvedValue({
      authorizationServerMetadata: { client_id_metadata_document_supported: true },
      resourceMetadata: { scopes_supported: [] },
    });
    const out = await startMcpAuthorization(
      SCOPE,
      {
        ...add,
        endpointUrl: "https://mcp.example.dev/mcp",
        redirectUrl: "http://localhost:3000/api/v1/mcp/oauth/callback",
      },
      { fetchFn },
    );
    expect(out).toEqual({ status: "client_required", scopesSupported: [] });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("stores a supplied OAuth app, skips discovery and requests its scopes", async () => {
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL(
        "https://slack.com/oauth/v2_user/authorize?x=1",
      );
      return "REDIRECT";
    });
    const out = await startMcpAuthorization(
      SCOPE,
      {
        ...add,
        name: "Slack",
        endpointUrl: "https://mcp.slack.com/mcp",
        client: {
          clientId: "123.456",
          clientSecret: "shh",
          scopes: "chat:write  users:read",
        },
      },
      { fetchFn, newState: () => "s2" },
    );
    expect(out.status).toBe("redirect");
    expect(m.setSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        orgListingId: "row-uuid",
        authKind: "oauth",
        oauthClientId: "123.456",
        oauthClientSecret: "shh",
        scopes: ["chat:write", "users:read"],
      }),
    );
    expect(m.discover).not.toHaveBeenCalled();
    expect(m.auth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "chat:write  users:read" }),
    );
  });

  it("answers not_oauth for an endpoint that asks for no OAuth, and stores nothing", async () => {
    m.detect.mockResolvedValue("none");
    const out = await startMcpAuthorization(SCOPE, add, { fetchFn });
    expect(out).toEqual({ status: "not_oauth" });
    expect(m.inserts).toHaveLength(0);
  });

  it("tries sign-in, not an open connect, for a server that did not answer the probe", async () => {
    m.detect.mockResolvedValue("unknown");
    m.discover.mockRejectedValue(new Error("timeout"));
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({ reason: "authorization_discovery_failed" });
    expect(m.inserts).toHaveLength(1);
  });

  it("refuses to reconnect a provider whose listing is not OAuth", async () => {
    m.rows.push([
      {
        id: "listing-static",
        title: "Keyed",
        endpointUrl: "https://mcp.keyed.dev/mcp",
        authKind: "secret",
      },
    ]);
    await expect(
      startMcpAuthorization(
        SCOPE,
        { mcpServerId: "mcs_static", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "server_not_found" });
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.setSecret).not.toHaveBeenCalled();
  });

  it("refuses a private endpoint before probing it", async () => {
    await expect(
      startMcpAuthorization(
        SCOPE,
        { ...add, endpointUrl: "https://10.1.2.3/mcp" },
        { fetchFn },
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "endpoint_not_public",
    });
    expect(m.detect).not.toHaveBeenCalled();
  });

  it("refuses an input that names neither a provider nor an endpoint", async () => {
    await expect(
      startMcpAuthorization(SCOPE, { redirectUrl: REDIRECT }, { fetchFn }),
    ).rejects.toMatchObject({ reason: "provider_unnamed" });
  });

  it("reconnects an existing provider and records it when a refresh token still works", async () => {
    m.rows.push([
      {
        id: "listing-1",
        title: "Linear",
        endpointUrl: "https://mcp.linear.app/mcp",
        authKind: "oauth",
      },
    ]);
    m.getSecret.mockResolvedValue({
      oauthClientId: "dcr-client",
      oauthClientRedirectUri: REDIRECT,
    });
    m.auth.mockResolvedValue("AUTHORIZED");
    const out = await startMcpAuthorization(
      SCOPE,
      { mcpServerId: "mcs_1", redirectUrl: REDIRECT },
      { fetchFn },
    );
    expect(out).toEqual({
      status: "authorized",
      mcpServerId: "mcs_new",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    });
    expect(m.discover).not.toHaveBeenCalled();
    expect(m.change).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "enable" }),
    );
  });

  it("replaces a client registered for another callback when the server issues a new one", async () => {
    m.rows.push([
      {
        id: "listing-1",
        title: "Linear",
        endpointUrl: "https://mcp.linear.app/mcp",
        authKind: "oauth",
      },
    ]);
    m.getSecret.mockResolvedValue({
      oauthClientId: "old-client",
      oauthClientRedirectUri: "https://old.example/api/v1/mcp/oauth/callback",
    });
    m.discover.mockResolvedValue({
      authorizationServerMetadata: {
        registration_endpoint: "https://mcp.linear.app/register",
      },
      resourceMetadata: { scopes_supported: [] },
    });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://mcp.linear.app/authorize?state=s5");
      return "REDIRECT";
    });
    const out = await startMcpAuthorization(
      SCOPE,
      { mcpServerId: "mcs_1", redirectUrl: REDIRECT },
      { fetchFn, newState: () => "s5" },
    );
    expect(out).toMatchObject({ status: "redirect", state: "s5" });
    expect(m.setSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        orgListingId: "listing-1",
        oauthClientId: null,
        oauthClientRedirectUri: null,
        refreshToken: null,
      }),
    );
  });

  it("asks for a new OAuth app when the workspace's own was registered for another callback", async () => {
    m.rows.push([
      {
        id: "listing-1",
        title: "Slack",
        endpointUrl: "https://mcp.slack.com/mcp",
        authKind: "oauth",
      },
    ]);
    m.getSecret.mockResolvedValue({
      oauthClientId: "123.456",
      oauthClientRedirectUri: "https://old.example/api/v1/mcp/oauth/callback",
    });
    m.discover.mockResolvedValue({
      authorizationServerMetadata: {},
      resourceMetadata: { scopes_supported: ["chat:write"] },
    });
    await expect(
      startMcpAuthorization(
        SCOPE,
        { mcpServerId: "mcs_1", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).resolves.toEqual({
      status: "client_required",
      scopesSupported: ["chat:write"],
    });
    expect(m.setSecret).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("stores the endpoint a vanity registry URL redirects to", async () => {
    m.resolve.mockResolvedValue("https://api.example.dev/mcp");
    m.discover.mockResolvedValue({
      authorizationServerMetadata: {
        registration_endpoint: "https://api.example.dev/register",
      },
      resourceMetadata: { scopes_supported: [] },
    });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://api.example.dev/authorize");
      return "REDIRECT";
    });
    await startMcpAuthorization(
      SCOPE,
      { ...add, endpointUrl: "https://vanity.example.dev" },
      { fetchFn, newState: () => "s6" },
    );
    expect(m.inserts[0]?.values).toMatchObject({
      endpointUrl: "https://api.example.dev/mcp",
    });
  });

  it("says the metadata could not be read when a server publishes none and sign-in fails", async () => {
    m.discover.mockResolvedValue({
      resourceMetadata: undefined,
      authorizationServerMetadata: undefined,
    });
    m.clientInfo = undefined;
    m.auth.mockRejectedValueOnce(new Error("HTTP 404 registering client"));
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "authorization_discovery_failed",
    });
  });

  it("answers not_found for a reconnect of a provider not in this workspace", async () => {
    m.rows.push([]);
    await expect(
      startMcpAuthorization(
        SCOPE,
        { mcpServerId: "mcs_x", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "server_not_found" });
  });

  it("maps an SDK registration failure to client_required and any other to authorization_failed", async () => {
    m.getSecret.mockResolvedValue({
      oauthClientId: "x",
      oauthClientRedirectUri: REDIRECT,
    });
    m.auth.mockRejectedValueOnce(
      new Error(
        "Incompatible auth server: does not support dynamic client registration",
      ),
    );
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).resolves.toEqual({
      status: "client_required",
      scopesSupported: [],
    });
    m.auth.mockRejectedValueOnce(new Error("boom"));
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({
      reason: "authorization_failed",
    });
  });
  it("refuses with registration_refused when the server will not register a client", async () => {
    // Vercel answers registration with invalid_redirect_uri for any redirect
    // URL it has not approved, so no client exists after auth() throws.
    m.discover.mockResolvedValue({
      resourceMetadata: { scopes_supported: [] },
      authorizationServerMetadata: {
        registration_endpoint: "https://vercel.com/api/login/oauth/register",
      },
    });
    m.clientInfo = undefined;
    m.auth.mockRejectedValueOnce(
      new Error(
        "ServerError: The provided redirect URIs are not approved for use by this authorization server.",
      ),
    );
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "registration_refused",
    });
  });

  it("refuses with authorization_discovery_failed when the server's metadata cannot be read, and starts no sign-in", async () => {
    m.discover.mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "authorization_discovery_failed",
    });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("goes on to sign-in when discovery finds no authorization-server metadata to refuse on", async () => {
    m.discover.mockResolvedValue({ resourceMetadata: undefined });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://auth.x.dev/authorize");
      return "REDIRECT";
    });
    const out = await startMcpAuthorization(SCOPE, add, {
      fetchFn,
      newState: () => "s3",
    });
    expect(out).toMatchObject({ status: "redirect", state: "s3" });
  });

  it("refuses a REDIRECT that carries no sign-in URL rather than returning an empty one", async () => {
    m.getSecret.mockResolvedValue({
      oauthClientId: "x",
      oauthClientRedirectUri: REDIRECT,
    });
    m.auth.mockResolvedValue("REDIRECT");
    await expect(
      startMcpAuthorization(SCOPE, add, { fetchFn }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "authorization_failed",
    });
  });

  it("skips discovery for a host the platform holds a pre-registered client for", async () => {
    m.prereg.mockReturnValue({ clientId: "platform" });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://mcp.linear.app/authorize");
      return "REDIRECT";
    });
    await startMcpAuthorization(SCOPE, add, { fetchFn, newState: () => "s4" });
    expect(m.discover).not.toHaveBeenCalled();
    expect(m.prereg).toHaveBeenCalledWith("https://mcp.linear.app/mcp");
  });

  it("keys a custom server by its endpoint, marks it custom, and drops an icon that is not https", async () => {
    m.getSecret.mockResolvedValue({
      oauthClientId: "x",
      oauthClientRedirectUri: REDIRECT,
    });
    m.auth.mockImplementation(async () => {
      m.pendingRedirect = new URL("https://auth.acme.dev/authorize");
      return "REDIRECT";
    });
    await startMcpAuthorization(
      SCOPE,
      {
        name: "Acme",
        endpointUrl: "https://mcp.acme.dev/v1/mcp/",
        iconUrl: "http://acme.dev/icon.png",
        redirectUrl: REDIRECT,
      },
      { fetchFn, newState: () => "s5" },
    );
    expect(m.inserts[0]?.values).toMatchObject({
      source: "custom",
      name: "custom:mcp.acme.dev/v1/mcp",
      iconUrl: null,
      description: null,
    });
  });
});

describe("completeMcpAuthorization", () => {
  const saved = {
    codeVerifier: "v",
    orgId: "org-1",
    workspaceId: "ws-1",
    orgListingId: "listing-1",
    returnTo: "",
  };

  it("exchanges the code, upserts the provider and deletes the state", async () => {
    m.loadState.mockResolvedValue(saved);
    m.rows.push([
      {
        id: "listing-1",
        title: "Linear",
        name: "verified/linear",
        endpointUrl: "https://mcp.linear.app/mcp",
      },
    ]);
    m.auth.mockResolvedValue("AUTHORIZED");
    const out = await completeMcpAuthorization(
      SCOPE,
      { state: "s1", code: "c1", redirectUrl: REDIRECT },
      { fetchFn },
    );
    expect(out).toEqual({
      mcpServerId: "mcs_new",
      name: "Linear",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    });
    expect(m.auth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authorizationCode: "c1" }),
    );
    expect(m.inserts[0]?.values).toMatchObject({
      orgListingId: "listing-1",
      authStrategy: "bearer",
      healthStatus: "healthy",
    });
    expect(m.inserts[0]?.set).toMatchObject({ deletedAt: null, enabled: true });
    expect(m.deleteState).toHaveBeenCalledWith("s1");
    expect(m.snapshots).toHaveBeenCalled();
  });

  it("treats a state from another workspace as expired", async () => {
    m.loadState.mockResolvedValue({ ...saved, workspaceId: "ws-other" });
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "authorization_expired",
    });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("deletes the state and refuses when the exchange fails", async () => {
    m.loadState.mockResolvedValue(saved);
    m.rows.push([
      {
        id: "listing-1",
        title: null,
        name: "custom:x",
        endpointUrl: "https://mcp.x.dev/mcp",
      },
    ]);
    m.auth.mockRejectedValue(new Error("invalid_grant"));
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ reason: "authorization_failed" });
    expect(m.deleteState).toHaveBeenCalledWith("s1");
    expect(m.inserts).toHaveLength(0);
  });

  it("refuses when the listing was removed mid-flow", async () => {
    m.loadState.mockResolvedValue(saved);
    m.rows.push([]);
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ reason: "server_not_found" });
  });

  it("treats a state it cannot find as expired, and exchanges nothing", async () => {
    m.loadState.mockResolvedValue(null);
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "gone", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("treats a state from another organization as expired", async () => {
    m.loadState.mockResolvedValue({ ...saved, orgId: "org-other" });
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("spends the state when the listing was removed mid-flow", async () => {
    m.loadState.mockResolvedValue(saved);
    m.rows.push([
      { id: "listing-1", title: "x", name: "x", endpointUrl: null },
    ]);
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ reason: "server_not_found" });
    expect(m.deleteState).toHaveBeenCalledWith("s1");
    expect(m.auth).not.toHaveBeenCalled();
  });

  it("still records the provider when pinning its tools fails, and pins nothing for a server that listed none", async () => {
    m.loadState.mockResolvedValue(saved);
    const listing = {
      id: "listing-1",
      title: "Linear",
      name: "verified/linear",
      endpointUrl: "https://mcp.linear.app/mcp",
    };
    m.rows.push([listing]);
    m.auth.mockResolvedValue("AUTHORIZED");
    m.snapshots.mockRejectedValue(new Error("clickhouse down"));
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s1", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).resolves.toMatchObject({ mcpServerId: "mcs_new" });
    expect(m.change).toHaveBeenCalledTimes(1);

    m.snapshots.mockClear();
    m.rows.push([listing]);
    m.healthcheck.mockResolvedValue({
      status: "unreachable",
      discoveredTools: [],
      descriptors: [],
    });
    await expect(
      completeMcpAuthorization(
        SCOPE,
        { state: "s2", code: "c", redirectUrl: REDIRECT },
        { fetchFn },
      ),
    ).resolves.toMatchObject({ healthStatus: "unreachable" });
    expect(m.snapshots).not.toHaveBeenCalled();
    // Stored as not yet known, so the runtime still offers the provider.
    expect(m.inserts.at(-1)?.values).toMatchObject({ healthStatus: "unknown" });
  });
});

// Once a workspace's tools live in its steering repo (M13, #4478, ADR-209 §6),
// a sign-in stores the tokens but writes no enabled legacy row. An enabled row
// would connect the server before review, and a legacy row would put the
// workspace back on direct writes.
describe("recording an authorized server once tools live in the steering repo", () => {
  const saved = {
    codeVerifier: "v",
    orgId: "org-1",
    workspaceId: "ws-1",
    orgListingId: "listing-1",
    returnTo: "",
  };
  const listing = {
    id: "listing-1",
    title: "Linear",
    name: "verified/linear",
    endpointUrl: "https://mcp.linear.app/mcp",
  };
  const row = (over: Record<string, unknown>) => ({
    id: "srv-2",
    publicId: "mcs_2",
    origin: "legacy",
    steeringName: null,
    enabled: false,
    deletedAt: null,
    deletedById: null,
    ...over,
  });
  const complete = () =>
    completeMcpAuthorization(
      SCOPE,
      { state: "s1", code: "c1", redirectUrl: REDIRECT },
      { fetchFn },
    );

  beforeEach(() => {
    m.loadState.mockResolvedValue(saved);
    m.auth.mockResolvedValue("AUTHORIZED");
    m.steeringWriter.mockResolvedValue({
      addServer: m.addServer,
      addTools: vi.fn(),
    });
  });

  it("proposes a new server in a steering PR, pins its tools first, and records no enable", async () => {
    m.rows.push([listing], []);

    const out = await complete();

    expect(out).toEqual({
      mcpServerId: "mcs_new",
      name: "Linear",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
      steeringPr: { number: 12, url: STEERING_PR.url },
    });
    expect(m.steeringWriter).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(m.inserts).toHaveLength(1);
    expect(m.inserts[0]).toMatchObject({
      doNothing: true,
      set: undefined,
      values: {
        origin: "proposed",
        enabled: false,
        orgListingId: "listing-1",
        transportType: "streamable-http",
        authStrategy: "bearer",
        healthStatus: "healthy",
        createdById: "user-1",
      },
    });
    expect(m.snapshots).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerId: "row-uuid" }),
    );
    expect(m.addServer).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      serverId: "row-uuid",
      actorUserId: "user-1",
    });
    // The folder the PR adds lists the tools the probe pinned.
    expect(m.snapshots.mock.invocationCallOrder[0]).toBeLessThan(
      m.addServer.mock.invocationCallOrder[0] as number,
    );
    expect(m.change).not.toHaveBeenCalled();
    expect(m.deleteState).toHaveBeenCalledWith("s1");
  });

  it("turns a disabled legacy row into a proposal and keeps its id", async () => {
    m.rows.push([listing], [row({})]);

    const out = await complete();

    expect(out).toMatchObject({ mcpServerId: "mcs_2", steeringPr: { number: 12 } });
    expect(m.inserts).toEqual([]);
    expect(m.updates[0]?.set).toMatchObject({
      origin: "proposed",
      enabled: false,
      steeringName: null,
      name: "Linear",
      endpointUrl: "https://mcp.linear.app/mcp",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    });
    expect(m.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-2" }),
    );
    expect(m.change).not.toHaveBeenCalled();
  });

  it("leaves a server whose steering PR is open off, and says the sign-in is saved", async () => {
    m.rows.push([listing], [row({ origin: "proposed", steeringName: "linear" })]);

    await expect(complete()).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_pr_open",
      message: expect.stringContaining("tools/servers/linear/"),
    });
    // The code was exchanged, so the tokens are stored.
    expect(m.auth).toHaveBeenCalled();
    expect(m.inserts).toEqual([]);
    expect(m.updates).toEqual([]);
    expect(m.addServer).not.toHaveBeenCalled();
    expect(m.snapshots).not.toHaveBeenCalled();
    expect(m.change).not.toHaveBeenCalled();
  });

  it("writes a server the steering repo already holds directly", async () => {
    m.rows.push([listing], [row({ origin: "steering", steeringName: "linear" })]);

    const out = await complete();

    expect(out).not.toHaveProperty("steeringPr");
    expect(m.addServer).not.toHaveBeenCalled();
    expect(m.inserts[0]?.set).toMatchObject({ enabled: true });
    expect(m.change).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "enable" }),
    );
  });

  it("deletes the proposed row when the PR does not open, and records nothing", async () => {
    m.addServer.mockRejectedValue(new Error("GitHub is down"));
    m.rows.push([listing], []);

    await expect(complete()).rejects.toThrow("GitHub is down");

    expect(m.updates[0]?.set).toMatchObject({
      deletedAt: expect.any(Date),
      deletedById: "user-1",
    });
    expect(m.change).not.toHaveBeenCalled();
  });

  it("returns the steering PR when a stored refresh token still works", async () => {
    m.rows.push(
      [
        {
          id: "listing-1",
          title: "Linear",
          endpointUrl: "https://mcp.linear.app/mcp",
          authKind: "oauth",
        },
      ],
      [],
    );
    m.getSecret.mockResolvedValue({
      oauthClientId: "dcr-client",
      oauthClientRedirectUri: REDIRECT,
    });

    const out = await startMcpAuthorization(
      SCOPE,
      { mcpServerId: "mcs_1", redirectUrl: REDIRECT },
      { fetchFn },
    );

    expect(out).toEqual({
      status: "authorized",
      mcpServerId: "mcs_new",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
      steeringPr: { number: 12, url: STEERING_PR.url },
    });
    expect(m.change).not.toHaveBeenCalled();
  });

  it("writes an enabled legacy row in a workspace that has not migrated", async () => {
    m.steeringWriter.mockResolvedValue(null);
    m.rows.push([listing]);

    const out = await complete();

    expect(out).not.toHaveProperty("steeringPr");
    expect(m.steeringWriter).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(m.inserts).toHaveLength(1);
    expect(m.inserts[0]?.values).toMatchObject({ enabled: true });
    expect(
      (m.inserts[0]?.values as Record<string, unknown>).origin,
    ).toBeUndefined();
    expect(m.inserts[0]?.set).toMatchObject({ enabled: true, deletedAt: null });
    expect(m.addServer).not.toHaveBeenCalled();
    expect(m.change).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "enable" }),
    );
  });
});
