import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
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

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

import { handler, installOne } from "./plugin.org.install";

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

const fakeManifest = {
  id: "oxagen/media-video",
  name: "Video Generation",
  description: "Generate videos from text prompts.",
  version: "1.0.0",
  tier: "premium",
  visibility: "ga",
  category: "media",
  icon: "clapperboard",
  contracts: ["video.generate"],
  scopes: [],
};

const hiddenManifest = {
  ...fakeManifest,
  id: "oxagen/hidden-plugin",
  visibility: "hidden",
};

/** Mock the single withTenantDb upsert call for capability installs. */
function mockCapabilityUpsert(returnId?: string) {
  const id = returnId ?? "porg-new-listing";
  mocks.withTenantDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id }]),
          }),
        }),
      }),
    }),
  );
}

/** Mock a custom server (mcp_server) withTenantDb upsert. */
function mockCustomUpsert(returnId?: string) {
  const id = returnId ?? "porg-custom-listing";
  mocks.withTenantDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id }]),
          }),
        }),
      }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("installOne — agent_capability path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
  });

  it("happy path: inserts correct row and returns orgListingId", async () => {
    mockCapabilityUpsert("porg-abc123");
    const id = await installOne(ctx, { pluginType: "agent_capability", pluginId: "oxagen/media-video" });
    expect(id).toBe("porg-abc123");
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("throws when pluginId is missing", async () => {
    await expect(
      installOne(ctx, { pluginType: "agent_capability" }),
    ).rejects.toThrow("pluginId is required when pluginType is 'agent_capability'");
  });

  it("throws when pluginId is not in the registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      installOne(ctx, { pluginType: "agent_capability", pluginId: "oxagen/nonexistent" }),
    ).rejects.toThrow("Unknown capability plugin");
  });

  it("throws when plugin visibility is hidden", async () => {
    mocks.getOxagenPlugin.mockReturnValue(hiddenManifest);
    await expect(
      installOne(ctx, { pluginType: "agent_capability", pluginId: "oxagen/hidden-plugin" }),
    ).rejects.toThrow("not publicly installable");
  });

  it("is idempotent — re-install returns the same listing id", async () => {
    // onConflictDoUpdate returns the existing row's id
    mockCapabilityUpsert("porg-existing-id");
    const id = await installOne(ctx, { pluginType: "agent_capability", pluginId: "oxagen/media-video" });
    expect(id).toBe("porg-existing-id");
  });

  it("does NOT hit the denylist — no denylist lookup is performed", async () => {
    // Only one withTenantDb call (the upsert) — no denylist query.
    mockCapabilityUpsert("porg-no-denylist");
    await installOne(ctx, { pluginType: "agent_capability", pluginId: "oxagen/media-video" });
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("does not call getOxagenPlugin for non-capability types", async () => {
    mockCustomUpsert("porg-mcp-1");
    await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "my-server",
        endpointUrl: "https://example.com/mcp",
        transport: "sse",
        authKind: "none",
      },
    });
    expect(mocks.getOxagenPlugin).not.toHaveBeenCalled();
  });

  it("throws when workspaceId is missing from ctx", async () => {
    const ctxNoWs = { ...ctx, workspaceId: null } as unknown as typeof ctx;
    await expect(
      installOne(ctxNoWs, { pluginType: "agent_capability", pluginId: "oxagen/media-video" }),
    ).rejects.toThrow("workspaceId is required");
  });
});

describe("installOne — custom mcp_server path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when custom is missing for non-capability types", async () => {
    await expect(
      installOne(ctx, { pluginType: "mcp_server" }),
    ).rejects.toThrow("custom is required");
  });

  it("happy path: inserts correct row and returns orgListingId", async () => {
    mockCustomUpsert("porg-mcp-new");
    const id = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: {
        name: "my-server",
        title: "My Server",
        description: "A test server",
        endpointUrl: "https://example.com/mcp",
        transport: "sse",
        authKind: "none",
      },
    });
    expect(id).toBe("porg-mcp-new");
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});

describe("plugin.org.install handler — audit event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
  });

  it("emits plugin.installed on success with workspace scope (SOC2 audit trail)", async () => {
    mockCapabilityUpsert("porg-audited");
    const out = (await handler(
      { pluginType: "agent_capability", pluginId: "oxagen/media-video" },
      ctx,
    )) as { orgListingId: string };
    expect(out.orgListingId).toBe("porg-audited");
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.installed",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        capability: "plugin.org.install",
        outcome: "success",
        requestId: "req-1",
      }),
    );
  });

  it("does NOT emit an audit event when install fails", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      handler({ pluginType: "agent_capability", pluginId: "oxagen/nonexistent" }, ctx),
    ).rejects.toThrow("Unknown capability plugin");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});
