import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  discover: vi.fn(),
  detect: vi.fn(),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  prereg: vi.fn(),
  loadState: vi.fn(),
  deleteState: vi.fn(),
  healthcheck: vi.fn(),
  snapshots: vi.fn(),
  change: vi.fn(),
  rows: [] as unknown[][],
  inserts: [] as { values: unknown; set: unknown }[],
  pendingRedirect: null as URL | null,
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
  },
  getWorkspaceSecret: m.getSecret,
  setWorkspaceSecret: m.setSecret,
  preregisteredClientForEndpoint: m.prereg,
  loadOAuthState: m.loadState,
  deleteOAuthState: m.deleteState,
}));

vi.mock("./mcp-auth-probe", () => ({ probeMcpAuth: m.detect }));
vi.mock("../dispatch/mcp-client", () => ({ healthcheck: m.healthcheck }));
vi.mock("./mcp-snapshots", () => ({
  captureToolSnapshots: m.snapshots,
  recordServerChange: m.change,
}));

// A query builder that answers every select with the next queued row set and
// records every insert.
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
    const rec = { values: undefined as unknown, set: undefined as unknown };
    const chain = {
      values: (v: unknown) => {
        rec.values = v;
        return chain;
      },
      onConflictDoUpdate: (o: { set: unknown }) => {
        rec.set = o.set;
        return chain;
      },
      returning: async () => {
        m.inserts.push(rec);
        return [{ id: "row-uuid", publicId: "mcs_new" }];
      },
    };
    return chain;
  };
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({ select, insert }),
  };
});

import {
  assertRedirectUrl,
  completeMcpAuthorization,
  listingKeyOf,
  startMcpAuthorization,
} from "./mcp-oauth-flow";

const SCOPE = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };
const REDIRECT = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";
const fetchFn = vi.fn() as unknown as typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.inserts = [];
  m.pendingRedirect = null;
  m.detect.mockResolvedValue("oauth");
  m.getSecret.mockResolvedValue(null);
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
    m.getSecret.mockResolvedValue({ oauthClientId: "dcr-client" });
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
    m.getSecret.mockResolvedValue({ oauthClientId: "x" });
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
    m.getSecret.mockResolvedValue({ oauthClientId: "x" });
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
    m.getSecret.mockResolvedValue({ oauthClientId: "x" });
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
  });
});
