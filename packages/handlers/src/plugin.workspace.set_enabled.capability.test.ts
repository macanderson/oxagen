import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb, withTenantDb: mocks.withTenantDb };
});

import { handler } from "./plugin.workspace.set_enabled";

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
  mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
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

describe("plugin.workspace.set_enabled handler — capability guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws Phase 2 error when listing.pluginType is 'capability' (enabled=true)", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      name: "oxagen/media-video",
      pluginType: "capability",
      enabled: true,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler({ orgListingId: "porg-cap-1", enabled: true }, ctx),
    ).rejects.toThrow("Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2");
  });

  it("throws Phase 2 error when listing.pluginType is 'capability' (enabled=false)", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      name: "oxagen/media-video",
      pluginType: "capability",
      enabled: false,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler({ orgListingId: "porg-cap-1", enabled: false }, ctx),
    ).rejects.toThrow("Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2");
  });

  it("error message directs user to plugin.org.set_enabled", async () => {
    mockListingLookup({
      id: "porg-cap-1",
      orgId: "org-1",
      name: "oxagen/media-video",
      pluginType: "capability",
      enabled: true,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      deletedAt: null,
    });

    await expect(
      handler({ orgListingId: "porg-cap-1", enabled: true }, ctx),
    ).rejects.toThrow("plugin.org.set_enabled");
  });

  it("does NOT throw Phase 2 error for mcp_server listings (normal enable path continues)", async () => {
    mockListingLookup({
      id: "porg-mcp-1",
      orgId: "org-1",
      name: "my-mcp-server",
      pluginType: "mcp_server",
      enabled: true,
      endpointUrl: "https://example.com/mcp",
      transport: "sse",
      authKind: "none",
      deletedAt: null,
    });

    // Denylist check — no entry
    mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    );

    // withTenantDb for upsert
    mocks.withTenantDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
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

    const result = await handler({ orgListingId: "porg-mcp-1", enabled: true }, ctx) as {
      workspaceServerId: string | null;
    };
    expect(result.workspaceServerId).toBe("mcp-pub-1");
  });

  it("throws when workspaceId is missing", async () => {
    await expect(
      handler({ orgListingId: "porg-1", enabled: true }, ctxNoWorkspace),
    ).rejects.toThrow("workspaceId is required");
  });

  it("throws when org listing not found", async () => {
    mockListingLookup(null);
    await expect(
      handler({ orgListingId: "porg-nonexistent", enabled: true }, ctx),
    ).rejects.toThrow("not found or deleted");
  });
});
