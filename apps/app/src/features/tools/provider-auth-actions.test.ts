// The wizard's registry search and OAuth actions (#4132): each resolves the
// viewer first; the callback URL is on the origin the person is using, unless
// that host is not the app's own; a sign-in URL that is not https is refused;
// a started flow is recorded in a cookie scoped to the callback path, newest
// first and at most four; and nothing a credential touches comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  headers: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ get: mocks.cookieGet, set: mocks.cookieSet }),
  headers: () =>
    Promise.resolve({ get: (name: string) => mocks.headers.get(name) ?? null }),
}));
vi.mock("@/server/viewer", () => ({ requireViewer: mocks.viewer }));
vi.mock("@/server/kernel", () => ({
  kernelRead: mocks.read,
  kernelWrite: mocks.write,
  readToActionResult: (read: { ok: false; reason: string }) => ({
    ok: false,
    reason: read.reason,
    code: "read_failed",
  }),
}));

const {
  completeProviderAuthorization,
  providerRedirectUrl,
  searchRegistry,
  startProviderAuthorization,
} = await import("./provider-auth-actions");

const CTX = { orgId: "org-1" };
const CALLBACK = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";
const STATE = "q".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  // The configured origin is the app's own host. Pin it, so the answer does
  // not depend on the NEXT_PUBLIC_APP_URL of the machine running the test
  // (CI sets it to http://localhost:3000).
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.oxagen.sh");
  mocks.headers.clear();
  mocks.headers.set("host", "app.oxagen.sh");
  mocks.viewer.mockResolvedValue(CTX);
  mocks.cookieGet.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("searchRegistry", () => {
  const linear = {
    id: "verified/linear",
    name: "Linear",
    description: "",
    publisher: "linear.app",
    publisherVerified: true,
    source: "verified",
    version: null,
    iconUrl: "https://linear.app/favicon.ico",
    websiteUrl: null,
    docsUrl: null,
    repositoryUrl: null,
    endpointUrl: "https://mcp.linear.app/mcp",
    transports: ["streamable-http"],
    auth: "oauth",
    authHeader: null,
    oauthRegistration: "dynamic",
    connectable: true,
  };

  it("reads a page as the viewer, trimming the query", async () => {
    mocks.read.mockResolvedValue({
      ok: true,
      value: { servers: [linear], nextCursor: "c", registryReachable: true },
    });
    const out = await searchRegistry("acme", "core", {
      query: "  linear ",
      cursor: "c1",
    });
    expect(mocks.viewer).toHaveBeenCalledWith("acme", "core");
    const call = mocks.read.mock.calls[0] ?? [];
    expect(call[0]).toBe(CTX);
    expect(call[1]).toMatchObject({
      contract: { name: "search_mcp_registry" },
      input: { query: "linear", cursor: "c1", limit: 20 },
      page: "tools",
    });
    // The registry's name for a server is not an Oxagen id, so the view
    // model calls it registryRef.
    const { id, ...rest } = linear;
    expect(out).toEqual({
      ok: true,
      value: {
        servers: [{ registryRef: id, ...rest }],
        nextCursor: "c",
        registryReachable: true,
      },
    });
  });

  it("refuses a page whose icon is not https rather than rendering it", async () => {
    mocks.read.mockResolvedValue({
      ok: true,
      value: {
        servers: [{ ...linear, iconUrl: "http://linear.app/i.png" }],
        nextCursor: null,
        registryReachable: true,
      },
    });
    expect(await searchRegistry("acme", "core", { query: "" })).toEqual({
      ok: false,
      reason: "unavailable",
      code: "record_unmappable",
    });
  });

  it("passes a failed read on", async () => {
    mocks.read.mockResolvedValue({ ok: false, reason: "denied" });
    expect(await searchRegistry("acme", "core", { query: "" })).toMatchObject({
      ok: false,
    });
  });
});

describe("startProviderAuthorization", () => {
  const add = {
    mode: "add" as const,
    name: " Linear ",
    endpointUrl: "https://mcp.linear.app/mcp",
    registryId: "verified/linear",
  };

  it("refuses an empty name or endpoint before resolving anyone", async () => {
    expect(
      await startProviderAuthorization("acme", "core", { ...add, name: " " }),
    ).toMatchObject({ reason: "invalid", field: "name" });
    expect(
      await startProviderAuthorization("acme", "core", {
        ...add,
        endpointUrl: "",
      }),
    ).toMatchObject({ reason: "invalid", field: "endpointUrl" });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("starts with the app's callback and records the flow in a cookie scoped to it", async () => {
    mocks.cookieGet.mockReturnValue({
      value: JSON.stringify([
        { org: "acme", ws: "core", state: "1".repeat(32) },
        { org: "acme", ws: "core", state: "2".repeat(32) },
        { org: "acme", ws: "core", state: "3".repeat(32) },
        { org: "acme", ws: "core", state: "4".repeat(32) },
      ]),
    });
    mocks.write.mockResolvedValue({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://mcp.linear.app/authorize?x=1",
        state: STATE,
      },
    });
    const out = await startProviderAuthorization("acme", "core", {
      ...add,
      client: { clientId: " id ", clientSecret: "", scopes: " read " },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ name: "start_mcp_authorization" }),
      {
        redirectUrl: CALLBACK,
        client: { clientId: "id", scopes: "read" },
        name: "Linear",
        endpointUrl: "https://mcp.linear.app/mcp",
        registryId: "verified/linear",
      },
    );
    expect(out).toEqual({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "https://mcp.linear.app/authorize?x=1",
        state: STATE,
      },
    });
    const call = mocks.cookieSet.mock.calls[0] ?? [];
    expect(call[0]).toBe("oxagen_mcp_oauth");
    const flows: unknown = JSON.parse(String(call[1]));
    expect(flows).toHaveLength(4);
    expect(flows).toMatchObject([
      { org: "acme", ws: "core", state: STATE },
      {},
      {},
      {},
    ]);
    expect(call[2]).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/api/v1/mcp/oauth/callback",
    });
  });

  it("refuses a sign-in URL that is not https, and records no flow", async () => {
    mocks.write.mockResolvedValue({
      ok: true,
      value: {
        status: "redirect",
        authorizationUrl: "javascript:alert(1)",
        state: STATE,
      },
    });
    expect(await startProviderAuthorization("acme", "core", add)).toEqual({
      ok: false,
      reason: "unavailable",
      code: "authorization_url_invalid",
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("reconnects by the provider's id and passes the other outcomes on", async () => {
    mocks.write.mockResolvedValueOnce({
      ok: true,
      value: {
        status: "authorized",
        mcpServerId: "mcs_1",
        healthStatus: "healthy",
        discoveredTools: ["a"],
      },
    });
    expect(
      await startProviderAuthorization("acme", "core", {
        mode: "reconnect",
        serverId: "mcs_1",
      }),
    ).toEqual({
      ok: true,
      value: {
        status: "authorized",
        serverId: "mcs_1",
        healthStatus: "healthy",
        discoveredTools: ["a"],
      },
    });
    expect(mocks.write.mock.calls[0]?.[2]).toEqual({
      redirectUrl: CALLBACK,
      mcpServerId: "mcs_1",
    });
    mocks.write.mockResolvedValueOnce({
      ok: true,
      value: { status: "client_required", scopesSupported: ["a", "b"] },
    });
    expect(await startProviderAuthorization("acme", "core", add)).toEqual({
      ok: true,
      value: {
        status: "client_required",
        scopesSupported: ["a", "b"],
        redirectUrl: CALLBACK,
      },
    });
    mocks.write.mockResolvedValueOnce({
      ok: true,
      value: { status: "not_oauth" },
    });
    expect(await startProviderAuthorization("acme", "core", add)).toEqual({
      ok: true,
      value: { status: "not_oauth" },
    });
    mocks.write.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(await startProviderAuthorization("acme", "core", add)).toMatchObject(
      {
        reason: "denied",
      },
    );
  });
});

describe("the callback URL", () => {
  it("uses the forwarded origin for the app's own host and for localhost", async () => {
    mocks.headers.set("x-forwarded-host", "localhost:3000");
    mocks.headers.set("x-forwarded-proto", "http");
    expect(await providerRedirectUrl("acme", "core")).toEqual({
      ok: true,
      value: { redirectUrl: "http://localhost:3000/api/v1/mcp/oauth/callback" },
    });
  });

  it("falls back to the configured origin for any other host", async () => {
    mocks.headers.set("x-forwarded-host", "evil.example");
    expect(await providerRedirectUrl("acme", "core")).toEqual({
      ok: true,
      value: { redirectUrl: CALLBACK },
    });
  });
});

describe("completeProviderAuthorization", () => {
  it("exchanges the code as the viewer with the same callback", async () => {
    mocks.write.mockResolvedValue({
      ok: true,
      value: {
        mcpServerId: "mcs_1",
        name: "Linear",
        healthStatus: "healthy",
        discoveredTools: [],
      },
    });
    expect(
      await completeProviderAuthorization("acme", "core", {
        state: STATE,
        code: "c",
      }),
    ).toEqual({
      ok: true,
      value: {
        serverId: "mcs_1",
        name: "Linear",
        healthStatus: "healthy",
        discoveredTools: [],
      },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ name: "authorize_mcp_server" }),
      { state: STATE, code: "c", redirectUrl: CALLBACK },
    );
    mocks.write.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "authorization_expired",
    });
    expect(
      await completeProviderAuthorization("acme", "core", {
        state: STATE,
        code: "c",
      }),
    ).toMatchObject({ code: "authorization_expired" });
  });
});
