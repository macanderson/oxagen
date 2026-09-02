import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  emitSecurityEvent: vi.fn(),
  listServers: vi.fn(),
  deriveTransportTypes: vi.fn(),
  deriveAuthKind: vi.fn(),
  detectOAuthProtected: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

vi.mock("@oxagen/plugins/registry", () => ({
  listServers: mocks.listServers,
  deriveTransportTypes: mocks.deriveTransportTypes,
  deriveAuthKind: mocks.deriveAuthKind,
}));

// Spread the real module and override ONLY detectOAuthProtected — a full
// factory replacement would drop the many other @oxagen/plugins exports that
// the handler's import chain needs transitively.
vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return { ...real, detectOAuthProtected: mocks.detectOAuthProtected };
});

import { installOne } from "./plugin.org.install";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

/** A minimal fake registry row returned by withSystemDb. */
const fakeRegistry = { id: "reg-1", baseUrl: "https://registry.example.com" };

/** A minimal ServerResponse with a remote endpoint. */
const fakeServerResponse = {
  server: {
    name: "my-mcp-server",
    description: "A test MCP server",
    version: "1.0.0",
    title: "My MCP Server",
    remotes: [{ type: "sse", url: "https://mcp.example.com/mcp" }],
    packages: [],
  },
  _meta: { isLatest: true, status: "active" },
};

/** Mock withSystemDb to return a list of registries. */
function mockRegistryQuery(registries: (typeof fakeRegistry)[]) {
  mocks.withSystemDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(registries),
          }),
        }),
      }),
  );
}

/**
 * Mock the catalog icon lookup withTenantDb call that now precedes the upsert
 * for all non-agent_capability plugin types. Returns null (no catalog entry) —
 * the handler treats this as non-fatal and continues.
 */
function mockIconLookup() {
  mocks.withTenantDb.mockImplementationOnce(async () => null);
}

/**
 * Mock the withTenantDb upsert for non-capability installs. Also mocks the
 * icon lookup call that precedes it in the handler.
 */
function mockUpsert(returnId = "porg-registry-listing") {
  // First: icon lookup (non-fatal, returns null → no catalog entry).
  mockIconLookup();
  // Second: the actual upsert. returning() echoes the inserted authKind, like
  // the real DB does for a fresh insert.
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: (vals: Record<string, unknown>) => ({
            onConflictDoUpdate: () => ({
              returning: () =>
                Promise.resolve([{ id: returnId, authKind: vals.authKind }]),
            }),
          }),
        }),
      }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("installOne — registry install (empty endpointUrl)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: deriveTransportTypes and deriveAuthKind return sensible values.
    mocks.deriveTransportTypes.mockReturnValue(["sse"]);
    mocks.deriveAuthKind.mockReturnValue("secret");
    // Default probe verdict: not OAuth-protected. Individual tests override.
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  it("resolves endpoint from registry and stores source='registry' with the resolved URL", async () => {
    mockRegistryQuery([fakeRegistry]);
    mocks.listServers.mockResolvedValueOnce({ servers: [fakeServerResponse] });

    // Mock the icon lookup that precedes the upsert in the handler.
    mockIconLookup();

    let capturedValues: Record<string, unknown> | null = null;
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: (vals: Record<string, unknown>) => {
              capturedValues = vals;
              return {
                onConflictDoUpdate: () => ({
                  returning: () =>
                    Promise.resolve([
                      { id: "porg-resolved", authKind: vals.authKind },
                    ]),
                }),
              };
            },
          }),
        }),
    );

    const { id } = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "my-mcp-server",
        endpointUrl: "", // empty → registry install
        transport: "sse",
        authKind: "none",
      },
    });

    expect(id).toBe("porg-resolved");
    // source must be "registry" (not "custom")
    expect(capturedValues).not.toBeNull();
    expect(capturedValues!.source).toBe("registry");
    // endpointUrl must be the resolved remote URL, not ""
    expect(capturedValues!.endpointUrl).toBe("https://mcp.example.com/mcp");
    // listServers was called with the registry baseUrl and server name as search
    expect(mocks.listServers).toHaveBeenCalledWith(
      fakeRegistry.baseUrl,
      expect.objectContaining({ search: "my-mcp-server" }),
    );
  });

  it("throws a descriptive error when server is not found in any enabled registry", async () => {
    mockRegistryQuery([fakeRegistry]);
    // Registry returns no matching server
    mocks.listServers.mockResolvedValueOnce({ servers: [] });

    await expect(
      installOne(ctx, {
        pluginType: "mcp_server",
        custom: {
          name: "nonexistent-server",
          endpointUrl: "",
          transport: "sse",
          authKind: "none",
        },
      }),
    ).rejects.toThrow(
      'Server "nonexistent-server" not found in any connected registry',
    );
  });

  it("throws when no registries are enabled for the workspace", async () => {
    mockRegistryQuery([]); // empty registry list
    // listServers should never be called
    await expect(
      installOne(ctx, {
        pluginType: "mcp_server",
        custom: {
          name: "some-server",
          endpointUrl: "",
          transport: "sse",
          authKind: "none",
        },
      }),
    ).rejects.toThrow(
      'Server "some-server" not found in any connected registry',
    );
    expect(mocks.listServers).not.toHaveBeenCalled();
  });

  it("skips a registry that throws a network error and continues to the next one", async () => {
    const reg2 = { id: "reg-2", baseUrl: "https://registry2.example.com" };
    mockRegistryQuery([fakeRegistry, reg2]);
    // First registry throws; second succeeds
    mocks.listServers
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({ servers: [fakeServerResponse] });
    mockUpsert("porg-fallback");

    const { id } = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "my-mcp-server",
        endpointUrl: "",
        transport: "sse",
        authKind: "none",
      },
    });

    expect(id).toBe("porg-fallback");
    // listServers called for both registries
    expect(mocks.listServers).toHaveBeenCalledTimes(2);
  });

  it("probes the REGISTRY-RESOLVED endpoint and upgrades a derived 'none' to 'oauth'", async () => {
    // The mcp.stripe.com case: server.json cannot declare OAuth, so
    // deriveAuthKind yields "none" — only the live probe can catch it.
    mockRegistryQuery([fakeRegistry]);
    mocks.listServers.mockResolvedValueOnce({ servers: [fakeServerResponse] });
    mocks.deriveAuthKind.mockReturnValue("none");
    mocks.detectOAuthProtected.mockResolvedValue(true);

    mockIconLookup();
    let capturedValues: Record<string, unknown> | null = null;
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: (vals: Record<string, unknown>) => {
              capturedValues = vals;
              return {
                onConflictDoUpdate: () => ({
                  returning: () =>
                    Promise.resolve([
                      { id: "porg-registry-oauth", authKind: vals.authKind },
                    ]),
                }),
              };
            },
          }),
        }),
    );

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "my-mcp-server",
        endpointUrl: "", // empty → resolved from the registry
        transport: "sse",
        authKind: "none",
      },
    });

    // Probed the endpoint the registry resolved, not the (empty) input URL.
    expect(mocks.detectOAuthProtected).toHaveBeenCalledWith(
      "https://mcp.example.com/mcp",
    );
    expect(capturedValues!.authKind).toBe("oauth");
    expect(res).toEqual({ id: "porg-registry-oauth", authKind: "oauth" });
  });
});

describe("installOne — truly-custom install (endpointUrl provided)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  it("stores the provided endpointUrl as-is with source='custom', no registry lookup", async () => {
    // Mock the icon lookup that precedes the upsert in the handler.
    mockIconLookup();

    let capturedValues: Record<string, unknown> | null = null;
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: (vals: Record<string, unknown>) => {
              capturedValues = vals;
              return {
                onConflictDoUpdate: () => ({
                  returning: () =>
                    Promise.resolve([
                      { id: "porg-custom", authKind: vals.authKind },
                    ]),
                }),
              };
            },
          }),
        }),
    );

    const { id } = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "hand-entered-server",
        title: "Hand Entered",
        endpointUrl: "https://custom.example.com/mcp",
        transport: "streamable-http",
        authKind: "secret",
      },
    });

    expect(id).toBe("porg-custom");
    expect(capturedValues!.source).toBe("custom");
    expect(capturedValues!.endpointUrl).toBe("https://custom.example.com/mcp");
    expect(capturedValues!.transport).toBe("streamable-http");
    expect(capturedValues!.authKind).toBe("secret");
    // No registry lookup occurred
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.listServers).not.toHaveBeenCalled();
  });
});
