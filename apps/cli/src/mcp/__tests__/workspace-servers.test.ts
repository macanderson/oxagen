/**
 * workspace-servers — the CLI→platform bridge that makes DB-backed,
 * workspace-installed MCP servers usable from the CLI turn. Covers config
 * synthesis (three auth kinds, stdio skip, file-based precedence), the
 * remoteFetch credential lookup (bearer / header / needs-reauth), and the
 * best-effort fetch (isolated on error / not-logged-in).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildWorkspaceServerConfigs,
  buildWorkspaceRemoteFetch,
  fetchWorkspaceMcpServers,
  type WorkspaceMcpServer,
} from "../workspace-servers.js";
import { resolveApiContext } from "../../lib/api.js";

// Mock the API layer so "logged in?" is deterministic regardless of the real
// machine config (the dev box running these tests may itself be logged in).
vi.mock("../../lib/api.js", () => ({
  resolveApiContext: vi.fn(() => null),
  apiGetOrThrow: vi.fn(),
}));
const mockedResolveApiContext = vi.mocked(resolveApiContext);
const LOGGED_IN = { apiUrl: "https://api.test", token: "t", org: "o", ws: "w" };

function server(
  overrides: Partial<WorkspaceMcpServer> = {},
): WorkspaceMcpServer {
  return {
    publicId: "srv_1",
    name: "github",
    transportType: "streamable-http",
    endpointUrl: "https://mcp.example.com/github",
    authStrategy: "bearer",
    authKind: "secret",
    token: "tok-123",
    headers: null,
    needsReauth: false,
    ...overrides,
  };
}

describe("buildWorkspaceServerConfigs", () => {
  it("synthesizes a streamable-http config carrying auth strategy but no secret", () => {
    const configs = buildWorkspaceServerConfigs([server()]);
    expect(configs.github).toBeDefined();
    const cfg = configs.github!;
    expect(cfg.transport).toBe("streamable-http");
    expect("url" in cfg && cfg.url).toBe("https://mcp.example.com/github");
    expect("auth" in cfg && cfg.auth).toBe("bearer");
    // The secret is never embedded in the config — it flows via remoteFetch.
    expect(JSON.stringify(cfg)).not.toContain("tok-123");
  });

  it("maps each of the three auth kinds to a config auth strategy", () => {
    const configs = buildWorkspaceServerConfigs([
      server({
        name: "none-srv",
        authStrategy: "none",
        authKind: "none",
        token: null,
      }),
      server({ name: "bearer-srv", authStrategy: "bearer" }),
      server({
        name: "header-srv",
        authStrategy: "header",
        token: null,
        headers: { "x-api-key": "k" },
      }),
    ]);
    expect("auth" in configs["none-srv"]! && configs["none-srv"]!.auth).toBe(
      "none",
    );
    expect(
      "auth" in configs["bearer-srv"]! && configs["bearer-srv"]!.auth,
    ).toBe("bearer");
    expect(
      "auth" in configs["header-srv"]! && configs["header-srv"]!.auth,
    ).toBe("header");
  });

  it("skips stdio servers (no remotely reachable endpoint)", () => {
    const configs = buildWorkspaceServerConfigs([
      server({ name: "local", transportType: "stdio" }),
    ]);
    expect(configs.local).toBeUndefined();
  });

  it("skips a DB server whose name collides with a file-based one (file wins)", () => {
    const configs = buildWorkspaceServerConfigs(
      [server({ name: "github" })],
      new Set(["github"]),
    );
    expect(configs.github).toBeUndefined();
  });
});

describe("buildWorkspaceRemoteFetch", () => {
  const remote = buildWorkspaceRemoteFetch([
    server({ name: "bearer-srv", authStrategy: "bearer", token: "tok-abc" }),
    server({
      name: "header-srv",
      authStrategy: "header",
      token: null,
      headers: { authorization: "Custom xyz" },
    }),
    server({
      name: "stale-srv",
      authKind: "oauth",
      token: null,
      needsReauth: true,
    }),
  ]);

  it("returns the bearer token as accessToken", async () => {
    expect(await remote("bearer-srv")).toEqual({
      accessToken: "tok-abc",
      tokenType: "Bearer",
      expiresAt: null,
    });
  });

  it("returns headers for header auth", async () => {
    expect(await remote("header-srv")).toEqual({
      headers: { authorization: "Custom xyz" },
      expiresAt: null,
    });
  });

  it("returns null for a needs-reauth server", async () => {
    expect(await remote("stale-srv")).toBeNull();
  });

  it("returns null for an unknown server", async () => {
    expect(await remote("does-not-exist")).toBeNull();
  });
});

describe("fetchWorkspaceMcpServers", () => {
  beforeEach(() => {
    mockedResolveApiContext.mockReset();
  });

  it("returns [] when not logged in without hitting the fetcher", async () => {
    mockedResolveApiContext.mockReturnValue(null);
    let called = false;
    const out = await fetchWorkspaceMcpServers(async () => {
      called = true;
      return { servers: [server()] };
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns the platform servers when logged in", async () => {
    mockedResolveApiContext.mockReturnValue(LOGGED_IN);
    const out = await fetchWorkspaceMcpServers(async () => ({
      servers: [server()],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("github");
  });

  it("isolates a fetch failure and returns []", async () => {
    mockedResolveApiContext.mockReturnValue(LOGGED_IN);
    const out = await fetchWorkspaceMcpServers(async () => {
      throw new Error("network down");
    });
    expect(out).toEqual([]);
  });
});
