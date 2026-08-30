import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

import { handler } from "./plugin.set_enabled";

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

// Cast through unknown to simulate a caller that omits workspaceId — we
// deliberately test the runtime guard, which accepts (input: unknown).
const ctxNoWorkspace = { ...ctx, workspaceId: null } as unknown as typeof ctx;

function mockListingLookup(listing: Record<string, unknown> | null) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(listing ? [listing] : []),
            }),
          }),
        }),
      }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("set_plugin_enabled handler (workspace scope) — capability guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws Phase 2 error when listing.pluginType is 'agent_capability' (enabled=true)", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "oxagen/media-video",
      pluginType: "agent_capability",
      enabled: true,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-cap-1", enabled: true },
        ctx,
      ),
    ).rejects.toThrow(
      "Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2",
    );
  });

  it("throws Phase 2 error when listing.pluginType is 'agent_capability' (enabled=false)", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "oxagen/media-video",
      pluginType: "agent_capability",
      enabled: false,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-cap-1", enabled: false },
        ctx,
      ),
    ).rejects.toThrow(
      "Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2",
    );
  });

  it("error message directs user to scope='org'", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "oxagen/media-video",
      pluginType: "agent_capability",
      enabled: true,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-cap-1", enabled: true },
        ctx,
      ),
    ).rejects.toThrow("scope='org'");
  });

  it("does NOT hit a denylist check before enabling (denylist removed)", async () => {
    // The listing lookup + the tenant upsert = exactly 2 withTenantDb calls.
    // No extra call for a denylist query should occur.
    mockListingLookup({
      id: "porg-mcp-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "my-mcp-server",
      pluginType: "mcp_server",
      enabled: true,
      endpointUrl: "https://example.com/mcp",
      transport: "sse",
      authKind: "none",
      deletedAt: null,
    });

    // withTenantDb for upsert
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: () => ({
                returning: () => Promise.resolve([{ publicId: "mcp-pub-1" }]),
              }),
            }),
          }),
        }),
    );

    await handler(
      { scope: "workspace", orgListingId: "porg-mcp-1", enabled: true },
      ctx,
    );

    // Exactly 2 calls: listing lookup + upsert. No denylist call.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("does NOT throw Phase 2 error for mcp_server listings (normal enable path continues)", async () => {
    mockListingLookup({
      id: "porg-mcp-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "my-mcp-server",
      pluginType: "mcp_server",
      enabled: true,
      endpointUrl: "https://example.com/mcp",
      transport: "sse",
      authKind: "none",
      deletedAt: null,
    });

    // withTenantDb for upsert
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: () => ({
                returning: () => Promise.resolve([{ publicId: "mcp-pub-1" }]),
              }),
            }),
          }),
        }),
    );

    const result = (await handler(
      { scope: "workspace", orgListingId: "porg-mcp-1", enabled: true },
      ctx,
    )) as {
      workspaceServerId: string | null;
    };
    expect(result.workspaceServerId).toBe("mcp-pub-1");

    // SOC2: successful enable emits a plugin.enabled_changed audit event with workspace scope.
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.enabled_changed",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        capability: "set_plugin_enabled",
        outcome: "success",
      }),
    );
  });

  it("disable path emits a plugin.enabled_changed audit event", async () => {
    mockListingLookup({
      id: "porg-mcp-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "my-mcp-server",
      pluginType: "mcp_server",
      enabled: true,
      endpointUrl: "https://example.com/mcp",
      transport: "sse",
      authKind: "none",
      deletedAt: null,
    });

    // withTenantDb for the disable update
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({
            set: () => ({
              where: () => Promise.resolve(),
            }),
          }),
        }),
    );

    const result = (await handler(
      { scope: "workspace", orgListingId: "porg-mcp-1", enabled: false },
      ctx,
    )) as {
      workspaceServerId: string | null;
    };
    expect(result.workspaceServerId).toBeNull();
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.enabled_changed",
        capability: "set_plugin_enabled",
        workspaceId: "ws-1",
        outcome: "success",
      }),
    );
  });

  it("does NOT emit an audit event when the Phase 2 guard throws", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      name: "oxagen/media-video",
      pluginType: "agent_capability",
      enabled: true,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-cap-1", enabled: true },
        ctx,
      ),
    ).rejects.toThrow();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("throws when workspaceId is missing", async () => {
    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-1", enabled: true },
        ctxNoWorkspace,
      ),
    ).rejects.toThrow("workspaceId is required");
  });

  it("throws when installed plugin not found", async () => {
    mockListingLookup(null);
    await expect(
      handler(
        { scope: "workspace", orgListingId: "porg-nonexistent", enabled: true },
        ctx,
      ),
    ).rejects.toThrow("not found or deleted");
  });
});
