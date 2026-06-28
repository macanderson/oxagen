/**
 * Unit tests for file-mcp.ts — the file-based MCP server plugin-type
 * contributor that reads from ~/.config/oxagen/settings.json.
 *
 * All @oxagen/mcp-config subpath modules and ../../dispatch/mcp-client are
 * mocked so no filesystem reads or live connections are made.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoist mocks ─────────────────────────────────────────────────────────────
vi.mock("pino", () => ({
  default: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../plugin-type", () => ({
  registerPluginType: vi.fn(),
}));

const resolveMocks = vi.hoisted(() => ({
  findProjectRoot: vi.fn(() => "/fake/project"),
  resolveSettings: vi.fn(() => ({
    settings: {},
    scopes: [],
    serverSources: {},
  })),
}));

vi.mock("@oxagen/mcp-config/resolve", () => ({
  findProjectRoot: resolveMocks.findProjectRoot,
  resolveSettings: resolveMocks.resolveSettings,
}));

const credMocks = vi.hoisted(() => ({
  resolveCredential: vi.fn<
    () => Promise<{
      token?: string;
      headers?: Record<string, string>;
      hasRefreshToken: boolean;
      source: string;
      expired: boolean;
    }>
  >(async () => ({
    token: undefined,
    headers: undefined,
    hasRefreshToken: false,
    source: "none",
    expired: false,
  })),
}));

vi.mock("@oxagen/mcp-config/credentials", () => ({
  resolveCredential: credMocks.resolveCredential,
}));

const permMocks = vi.hoisted(() => ({
  filterToolVisibility: vi.fn((allTools: string[]) => allTools),
  getNonDeniedTools: vi.fn((_serverName: string, tools: string[]) => tools),
}));

vi.mock("@oxagen/mcp-config/permissions", () => ({
  filterToolVisibility: permMocks.filterToolVisibility,
  getNonDeniedTools: permMocks.getNonDeniedTools,
}));

const managedMocks = vi.hoisted(() => ({
  loadManagedConfig: vi.fn<
    () => { managedPolicy?: unknown; servers: Record<string, unknown> } | null
  >(() => null),
  getManagedServers: vi.fn<() => Record<string, unknown>>(() => ({})),
  checkToolDenied: vi.fn<
    (serverName: string, tool: string) => { reason: string } | null
  >(() => null),
}));

vi.mock("@oxagen/mcp-config/managed", () => ({
  loadManagedConfig: managedMocks.loadManagedConfig,
  getManagedServers: managedMocks.getManagedServers,
  checkToolDenied: managedMocks.checkToolDenied,
}));

const mcpClientMocks = vi.hoisted(() => ({
  connectMcp: vi.fn<
    (args: {
      endpointUrl: string;
      authStrategy?: string;
      authConfig?: Record<string, string>;
    }) => Promise<Record<string, unknown>>
  >(async () => ({})),
  materializeMcpTools: vi.fn(async () => ({})),
}));

vi.mock("../../dispatch/mcp-client", () => ({
  connectMcp: mcpClientMocks.connectMcp,
  materializeMcpTools: mcpClientMocks.materializeMcpTools,
}));

// Import the module AFTER all vi.mock calls are declared.
import { contributeFileBasedMcpTools } from "./file-mcp";
import type { CapabilityContext } from "../../types";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: null,
};

/** Returns a basic HTTP server config (streamable-http). */
function httpServer(overrides: Record<string, unknown> = {}) {
  return {
    transport: "streamable-http",
    url: "https://my.mcp.example.com",
    auth: "none",
    ...overrides,
  };
}

describe("contributeFileBasedMcpTools — no servers", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: { mcpServers: {} },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    mcpClientMocks.connectMcp.mockReset();
    mcpClientMocks.materializeMcpTools.mockReset();
  });

  it("returns an empty array when there are no servers in settings", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
    expect(mcpClientMocks.connectMcp).not.toHaveBeenCalled();
  });
});

describe("contributeFileBasedMcpTools — disabled server", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          disabledSrv: { ...httpServer(), disabled: true },
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    mcpClientMocks.connectMcp.mockReset();
    mcpClientMocks.materializeMcpTools.mockReset();
  });

  it("skips a server marked disabled:true", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
    expect(mcpClientMocks.connectMcp).not.toHaveBeenCalled();
  });
});

describe("contributeFileBasedMcpTools — stdio server", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          stdioSrv: { transport: "stdio", command: "node", args: ["server.js"] },
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    mcpClientMocks.connectMcp.mockReset();
  });

  it("skips stdio transport servers (not yet supported)", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
    expect(mcpClientMocks.connectMcp).not.toHaveBeenCalled();
  });
});

describe("contributeFileBasedMcpTools — auth required but no credentials", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          bearerSrv: httpServer({ auth: "bearer" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    mcpClientMocks.connectMcp.mockReset();
  });

  it("skips a bearer-auth server when credential source is 'none'", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
    expect(mcpClientMocks.connectMcp).not.toHaveBeenCalled();
  });
});

describe("contributeFileBasedMcpTools — expired token without refresh", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          expiredSrv: httpServer({ auth: "bearer" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      token: "old_token",
      hasRefreshToken: false,
      source: "file" as const,
      expired: true,
    });
    mcpClientMocks.connectMcp.mockReset();
  });

  it("skips a server with an expired token and no refresh token", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
    expect(mcpClientMocks.connectMcp).not.toHaveBeenCalled();
  });
});

describe("contributeFileBasedMcpTools — successful tool contribution (none auth)", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          openSrv: httpServer({ auth: "none" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);

    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
    mcpClientMocks.materializeMcpTools.mockReset().mockResolvedValue({
      "file-mcp.openSrv.list_resources": {
        description: "List available resources",
        execute: vi.fn(async () => ({ items: [] })),
      },
    });
  });

  it("calls connectMcp with none auth strategy", async () => {
    await contributeFileBasedMcpTools(CTX);
    expect(mcpClientMocks.connectMcp).toHaveBeenCalledTimes(1);
    const [args] = mcpClientMocks.connectMcp.mock.calls[0] as unknown as [
      { endpointUrl: string; authStrategy: string },
    ];
    expect(args.endpointUrl).toBe("https://my.mcp.example.com");
    expect(args.authStrategy).toBe("none");
  });

  it("calls materializeMcpTools with the server prefix", async () => {
    await contributeFileBasedMcpTools(CTX);
    expect(mcpClientMocks.materializeMcpTools).toHaveBeenCalledTimes(1);
    const [, prefix] = mcpClientMocks.materializeMcpTools.mock.calls[0] as unknown as [unknown, string];
    expect(prefix).toBe("file-mcp.openSrv");
  });

  it("returns the tool with stripped tool name in realName", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.realName).toBe("file-mcp.openSrv.list_resources");
    expect(tools[0]?.externalServerId).toBe("file:openSrv");
    expect(typeof tools[0]?.execute).toBe("function");
  });
});

describe("contributeFileBasedMcpTools — bearer token auth", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          bearerSrv: httpServer({ auth: "bearer" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      token: "my_bearer_token",
      hasRefreshToken: false,
      source: "file" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);

    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
    mcpClientMocks.materializeMcpTools.mockReset().mockResolvedValue({
      "file-mcp.bearerSrv.call_tool": {
        description: "Call a tool",
        execute: vi.fn(async () => "result"),
      },
    });
  });

  it("passes bearer authStrategy and token to connectMcp", async () => {
    await contributeFileBasedMcpTools(CTX);
    const [args] = mcpClientMocks.connectMcp.mock.calls[0] as unknown as [
      { authStrategy: string; authConfig: Record<string, string> },
    ];
    expect(args.authStrategy).toBe("bearer");
    expect(args.authConfig).toEqual({ token: "my_bearer_token" });
  });
});

describe("contributeFileBasedMcpTools — header auth", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          headerSrv: httpServer({ auth: "header" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      headers: { "X-Api-Key": "secret123" },
      hasRefreshToken: false,
      source: "file" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);

    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
    mcpClientMocks.materializeMcpTools.mockReset().mockResolvedValue({
      "file-mcp.headerSrv.search": {
        description: "Search",
        execute: vi.fn(async () => []),
      },
    });
  });

  it("passes header authStrategy and headers to connectMcp", async () => {
    await contributeFileBasedMcpTools(CTX);
    const [args] = mcpClientMocks.connectMcp.mock.calls[0] as unknown as [
      { authStrategy: string; authConfig: Record<string, string> },
    ];
    expect(args.authStrategy).toBe("header");
    expect(args.authConfig).toEqual({ "X-Api-Key": "secret123" });
  });
});

describe("contributeFileBasedMcpTools — tool visibility and permission filtering", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          filteredSrv: httpServer(),
        },
        toolVisibility: {
          filteredSrv: { include: ["list_*"] },
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
    mcpClientMocks.materializeMcpTools.mockReset().mockResolvedValue({
      "file-mcp.filteredSrv.list_items": {
        description: "list",
        execute: vi.fn(async () => []),
      },
      "file-mcp.filteredSrv.delete_item": {
        description: "delete",
        execute: vi.fn(async () => undefined),
      },
    });
  });

  it("applies filterToolVisibility to limit visible tools", async () => {
    // Only allow list_items through visibility filter
    permMocks.filterToolVisibility.mockReturnValue(["list_items"]);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);

    const tools = await contributeFileBasedMcpTools(CTX);
    expect(permMocks.filterToolVisibility).toHaveBeenCalledTimes(1);
    // Only the visible tool should be contributed
    expect(tools.map((t) => t.realName)).toContain("file-mcp.filteredSrv.list_items");
    expect(tools.map((t) => t.realName)).not.toContain("file-mcp.filteredSrv.delete_item");
  });

  it("applies getNonDeniedTools to remove denied tools", async () => {
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    // Deny delete_item
    permMocks.getNonDeniedTools.mockImplementation(
      (_s: string, tools: string[]) => tools.filter((t) => !t.startsWith("delete")),
    );
    managedMocks.checkToolDenied.mockReturnValue(null);

    const tools = await contributeFileBasedMcpTools(CTX);
    expect(permMocks.getNonDeniedTools).toHaveBeenCalledTimes(1);
    expect(tools.map((t) => t.realName)).not.toContain("file-mcp.filteredSrv.delete_item");
  });

  it("applies managed policy tool denylist via checkToolDenied", async () => {
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    // Deny delete_item at managed policy level
    managedMocks.checkToolDenied.mockImplementation((_s: string, tool: string) =>
      tool === "delete_item" ? { reason: "policy" } : null,
    );

    const tools = await contributeFileBasedMcpTools(CTX);
    expect(managedMocks.checkToolDenied).toHaveBeenCalled();
    expect(tools.map((t) => t.realName)).not.toContain("file-mcp.filteredSrv.delete_item");
  });
});

describe("contributeFileBasedMcpTools — managed servers merged", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: { mcpServers: {} },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue({ managedPolicy: undefined, servers: {} });
    managedMocks.getManagedServers.mockReturnValue({
      managedSrv: httpServer({ url: "https://managed.mcp.example.com" }),
    });
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);
    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
    mcpClientMocks.materializeMcpTools.mockReset().mockResolvedValue({
      "file-mcp.managedSrv.fetch": {
        description: "fetch",
        execute: vi.fn(async () => "data"),
      },
    });
  });

  it("includes tools from managed servers even when settings.mcpServers is empty", async () => {
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.externalServerId).toBe("file:managedSrv");
  });
});

describe("contributeFileBasedMcpTools — per-server error isolation", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: {
          goodSrv: httpServer({ url: "https://good.example.com" }),
          badSrv: httpServer({ url: "https://bad.example.com" }),
        },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);
  });

  it("continues with remaining servers when one server throws on connectMcp", async () => {
    // The mock returns different values for subsequent calls.
    // badSrv: connectMcp throws; goodSrv: succeeds.
    // Since iteration order matches Object.entries, badSrv will be first or second
    // depending on insertion order. We configure the mock to alternate.
    let callCount = 0;
    mcpClientMocks.connectMcp.mockImplementation(async (args: { endpointUrl: string }) => {
      if (args.endpointUrl === "https://bad.example.com") {
        throw new Error("connection refused");
      }
      return {};
    });
    mcpClientMocks.materializeMcpTools.mockResolvedValue({
      "file-mcp.goodSrv.ping": {
        description: "ping",
        execute: vi.fn(async () => "pong"),
      },
    });
    void callCount;

    const tools = await contributeFileBasedMcpTools(CTX);
    // goodSrv contributes its tool; badSrv was skipped gracefully
    expect(tools.map((t) => t.realName)).toContain("file-mcp.goodSrv.ping");
  });

  it("does not throw when all servers fail — returns empty array", async () => {
    mcpClientMocks.connectMcp.mockRejectedValue(new Error("all down"));
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
  });
});

describe("contributeFileBasedMcpTools — tool without execute function is skipped", () => {
  beforeEach(() => {
    resolveMocks.resolveSettings.mockReturnValue({
      settings: {
        mcpServers: { execSrv: httpServer() },
      },
      scopes: [],
      serverSources: {},
    });
    managedMocks.loadManagedConfig.mockReturnValue(null);
    managedMocks.getManagedServers.mockReturnValue({});
    credMocks.resolveCredential.mockResolvedValue({
      hasRefreshToken: false,
      source: "none" as const,
      expired: false,
    });
    permMocks.filterToolVisibility.mockImplementation((tools: string[]) => tools);
    permMocks.getNonDeniedTools.mockImplementation((_s: string, tools: string[]) => tools);
    managedMocks.checkToolDenied.mockReturnValue(null);
    mcpClientMocks.connectMcp.mockReset().mockResolvedValue({});
  });

  it("skips a tool entry whose execute field is not a function", async () => {
    mcpClientMocks.materializeMcpTools.mockResolvedValue({
      "file-mcp.execSrv.no_exec": {
        description: "no execute",
        execute: undefined,
      },
    });
    const tools = await contributeFileBasedMcpTools(CTX);
    expect(tools).toEqual([]);
  });
});
