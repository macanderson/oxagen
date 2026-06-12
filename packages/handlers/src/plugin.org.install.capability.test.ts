import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
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

/** Mock the two sequential withSystemDb calls: denylist check + upsert. */
function mockHappyPath(existingId?: string) {
  // 1. Denylist check — no entry found
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
  // 2. Upsert — returns the row id
  const returnedId = existingId ?? "porg-new-listing";
  mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id: returnedId }]),
          }),
        }),
      }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("installOne — capability path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
  });

  it("happy path: inserts correct row and returns orgListingId", async () => {
    mockHappyPath("porg-abc123");
    const id = await installOne(ctx, { pluginType: "capability", pluginId: "oxagen/media-video" });
    expect(id).toBe("porg-abc123");
    // Verify insert was called with correct source and plugin metadata
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("throws when pluginId is missing", async () => {
    await expect(
      installOne(ctx, { pluginType: "capability" }),
    ).rejects.toThrow("pluginId is required when pluginType is 'capability'");
  });

  it("throws when pluginId is not in the registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      installOne(ctx, { pluginType: "capability", pluginId: "oxagen/nonexistent" }),
    ).rejects.toThrow("Unknown capability plugin");
  });

  it("throws when plugin visibility is hidden", async () => {
    mocks.getOxagenPlugin.mockReturnValue(hiddenManifest);
    await expect(
      installOne(ctx, { pluginType: "capability", pluginId: "oxagen/hidden-plugin" }),
    ).rejects.toThrow("not publicly installable");
  });

  it("throws when plugin is on the org denylist", async () => {
    // Denylist check returns a row
    mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: "pden-1" }]),
            }),
          }),
        }),
      }),
    );
    await expect(
      installOne(ctx, { pluginType: "capability", pluginId: "oxagen/media-video" }),
    ).rejects.toThrow("org denylist");
  });

  it("is idempotent — re-install returns the same listing id", async () => {
    // onConflictDoUpdate returns the existing row's id
    mockHappyPath("porg-existing-id");
    const id = await installOne(ctx, { pluginType: "capability", pluginId: "oxagen/media-video" });
    expect(id).toBe("porg-existing-id");
  });

  it("does not call getOxagenPlugin for non-capability types", async () => {
    // Ensure the mcp_server path still works without hitting plugin registry
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      id: "cs-1",
                      name: "my-server",
                      title: "My Server",
                      description: "desc",
                      icons: [],
                      transportTypes: ["sse"],
                      authKind: "none",
                      remotes: [{ url: "https://example.com/mcp", type: "sse" }],
                    },
                  ]),
              }),
            }),
          }),
        }),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: () => ({
                returning: () => Promise.resolve([{ id: "porg-mcp-1" }]),
              }),
            }),
          }),
        }),
      );

    await installOne(ctx, { pluginType: "mcp_server", catalogServerId: "cs-1" });
    expect(mocks.getOxagenPlugin).not.toHaveBeenCalled();
  });
});

describe("plugin.org.install handler — audit event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
  });

  it("emits plugin.installed on success (SOC2 audit trail)", async () => {
    mockHappyPath("porg-audited");
    const out = (await handler(
      { pluginType: "capability", pluginId: "oxagen/media-video" },
      ctx,
    )) as { orgListingId: string };
    expect(out.orgListingId).toBe("porg-audited");
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.installed",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: null,
        capability: "plugin.org.install",
        outcome: "success",
        requestId: "req-1",
      }),
    );
  });

  it("does NOT emit an audit event when install fails", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      handler({ pluginType: "capability", pluginId: "oxagen/nonexistent" }, ctx),
    ).rejects.toThrow("Unknown capability plugin");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});
