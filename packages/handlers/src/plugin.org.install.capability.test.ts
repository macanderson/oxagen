import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  emitSecurityEvent: vi.fn(),
  detectOAuthProtected: vi.fn(),
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

// Spread the real module and override ONLY detectOAuthProtected — a full
// factory replacement would drop the many other @oxagen/plugins exports that
// the handler's import chain needs transitively.
vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return { ...real, detectOAuthProtected: mocks.detectOAuthProtected };
});

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
  contracts: ["generate_video"],
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
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
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

/**
 * Mock the catalog icon lookup withTenantDb call that now precedes the upsert
 * for non-agent_capability plugin types (mcp_server, etc.). Returns null (no
 * catalog entry) — the handler treats this as non-fatal and continues.
 */
function mockIconLookup() {
  mocks.withTenantDb.mockImplementationOnce(async () => null);
}

/**
 * Mock a custom server (mcp_server) withTenantDb upsert. Also mocks the icon
 * lookup call that precedes it in the handler. Captures the inserted values
 * and — like the real DB returning() on a fresh insert — echoes the inserted
 * authKind back so installOne reports the persisted kind.
 */
function mockCustomUpsert(returnId?: string) {
  const id = returnId ?? "porg-custom-listing";
  const captured: { values: Record<string, unknown> | null } = { values: null };
  // First: icon lookup (non-fatal, returns null → no catalog entry).
  mockIconLookup();
  // Second: the actual upsert.
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            captured.values = vals;
            return {
              onConflictDoUpdate: () => ({
                returning: () =>
                  Promise.resolve([{ id, authKind: vals.authKind }]),
              }),
            };
          },
        }),
      }),
  );
  return captured;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("installOne — agent_capability path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
    // Default probe verdict: not OAuth-protected. Individual tests override.
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  it("happy path: inserts correct row and returns orgListingId + authKind", async () => {
    mockCapabilityUpsert("porg-abc123");
    const res = await installOne(ctx, {
      pluginType: "agent_capability",
      pluginId: "oxagen/media-video",
    });
    expect(res).toEqual({ id: "porg-abc123", authKind: "none" });
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("throws when neither pluginId nor catalogServerId is present", async () => {
    await expect(
      installOne(ctx, { pluginType: "agent_capability" }),
    ).rejects.toThrow(/is required when pluginType is 'agent_capability'/);
  });

  it("resolves the capability from catalogServerId when pluginId is absent (bulk path)", async () => {
    // The marketplace bulk install sends only catalogServerId; installOne must
    // fall back to it so the pack resolves without the caller pre-mapping to
    // pluginId. Regression for "pluginId is required" on every bulk capability.
    mockCapabilityUpsert("porg-from-catalog");
    const res = await installOne(ctx, {
      pluginType: "agent_capability",
      catalogServerId: "oxagen/media-video",
    });
    expect(res.id).toBe("porg-from-catalog");
    expect(mocks.getOxagenPlugin).toHaveBeenCalledWith("oxagen/media-video");
  });

  it("prefers pluginId over catalogServerId when both are present", async () => {
    mockCapabilityUpsert("porg-prefers-pluginid");
    await installOne(ctx, {
      pluginType: "agent_capability",
      pluginId: "oxagen/media-video",
      catalogServerId: "oxagen/should-be-ignored",
    });
    expect(mocks.getOxagenPlugin).toHaveBeenCalledWith("oxagen/media-video");
  });

  it("throws when pluginId is not in the registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      installOne(ctx, {
        pluginType: "agent_capability",
        pluginId: "oxagen/nonexistent",
      }),
    ).rejects.toThrow("Unknown capability plugin");
  });

  it("throws when plugin visibility is hidden", async () => {
    mocks.getOxagenPlugin.mockReturnValue(hiddenManifest);
    await expect(
      installOne(ctx, {
        pluginType: "agent_capability",
        pluginId: "oxagen/hidden-plugin",
      }),
    ).rejects.toThrow("not publicly installable");
  });

  it("is idempotent — re-install returns the same listing id", async () => {
    // onConflictDoUpdate returns the existing row's id
    mockCapabilityUpsert("porg-existing-id");
    const res = await installOne(ctx, {
      pluginType: "agent_capability",
      pluginId: "oxagen/media-video",
    });
    expect(res.id).toBe("porg-existing-id");
  });

  it("does NOT hit the denylist — no denylist lookup is performed", async () => {
    // Only one withTenantDb call (the upsert) — no denylist query.
    mockCapabilityUpsert("porg-no-denylist");
    await installOne(ctx, {
      pluginType: "agent_capability",
      pluginId: "oxagen/media-video",
    });
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
      installOne(ctxNoWs, {
        pluginType: "agent_capability",
        pluginId: "oxagen/media-video",
      }),
    ).rejects.toThrow("workspaceId is required");
  });
});

describe("installOne — custom mcp_server path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  it("throws when custom is missing for non-capability types", async () => {
    await expect(installOne(ctx, { pluginType: "mcp_server" })).rejects.toThrow(
      "custom is required",
    );
  });

  it("happy path: inserts correct row and returns orgListingId + authKind", async () => {
    mockCustomUpsert("porg-mcp-new");
    const res = await installOne(ctx, {
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
    expect(res).toEqual({ id: "porg-mcp-new", authKind: "none" });
    // Two withTenantDb calls: (1) icon lookup, (2) the upsert insert.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });
});

describe("installOne — OAuth detection probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  const customNone = {
    name: "stripe-mcp",
    endpointUrl: "https://mcp.stripe.com",
    transport: "streamable-http",
    authKind: "none" as const,
  };

  it("upgrades authKind none → oauth when the probe detects protection (mcp_server)", async () => {
    mocks.detectOAuthProtected.mockResolvedValue(true);
    const captured = mockCustomUpsert("porg-oauth-upgraded");

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: customNone,
    });

    expect(mocks.detectOAuthProtected).toHaveBeenCalledTimes(1);
    expect(mocks.detectOAuthProtected).toHaveBeenCalledWith(
      "https://mcp.stripe.com",
    );
    // The inserted row carries the upgraded kind…
    expect(captured.values).not.toBeNull();
    expect(captured.values!.authKind).toBe("oauth");
    // …and the result reports the persisted kind so the UI can prompt to auth.
    expect(res).toEqual({ id: "porg-oauth-upgraded", authKind: "oauth" });
  });

  it("also probes integration installs", async () => {
    mocks.detectOAuthProtected.mockResolvedValue(true);
    const captured = mockCustomUpsert("porg-integration-oauth");

    const res = await installOne(ctx, {
      pluginType: "integration",
      custom: customNone,
    });

    expect(mocks.detectOAuthProtected).toHaveBeenCalledTimes(1);
    expect(captured.values!.authKind).toBe("oauth");
    expect(res.authKind).toBe("oauth");
  });

  it("does NOT probe when authKind is explicitly oauth", async () => {
    const captured = mockCustomUpsert("porg-explicit-oauth");

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: { ...customNone, authKind: "oauth" as const },
    });

    expect(mocks.detectOAuthProtected).not.toHaveBeenCalled();
    expect(captured.values!.authKind).toBe("oauth");
    expect(res.authKind).toBe("oauth");
  });

  it("does NOT probe when authKind is explicitly secret (never downgrades a declared kind)", async () => {
    const captured = mockCustomUpsert("porg-secret");

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: { ...customNone, authKind: "secret" as const },
    });

    expect(mocks.detectOAuthProtected).not.toHaveBeenCalled();
    expect(captured.values!.authKind).toBe("secret");
    expect(res.authKind).toBe("secret");
  });

  it("keeps authKind none and still installs when the probe says not protected", async () => {
    // detectOAuthProtected's contract is "never throws" (network errors,
    // timeouts, and bad responses all resolve false — covered by its own unit
    // tests), so the not-protected verdict is the failure mode seen here.
    mocks.detectOAuthProtected.mockResolvedValue(false);
    const captured = mockCustomUpsert("porg-still-none");

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: customNone,
    });

    expect(mocks.detectOAuthProtected).toHaveBeenCalledTimes(1);
    expect(captured.values!.authKind).toBe("none");
    expect(res).toEqual({ id: "porg-still-none", authKind: "none" });
  });

  it("does NOT probe a non-http(s) endpoint", async () => {
    const captured = mockCustomUpsert("porg-stdio");

    await installOne(ctx, {
      pluginType: "mcp_server",
      custom: { ...customNone, endpointUrl: "stdio://local-server" },
    });

    expect(mocks.detectOAuthProtected).not.toHaveBeenCalled();
    expect(captured.values!.authKind).toBe("none");
  });

  it("does NOT probe non-server plugin types (agent_skill)", async () => {
    const captured = mockCustomUpsert("porg-skill");

    await installOne(ctx, { pluginType: "agent_skill", custom: customNone });

    expect(mocks.detectOAuthProtected).not.toHaveBeenCalled();
    expect(captured.values!.authKind).toBe("none");
  });

  it("reports the PERSISTED authKind when the conflict clause preserves a prior oauth row", async () => {
    // Reinstall race: this call's probe missed (false), but the existing row is
    // already "oauth" — the upgrade-only conflict clause keeps it, and installOne
    // must report what the DB returned, not what this call computed.
    mocks.detectOAuthProtected.mockResolvedValue(false);
    mockIconLookup();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: () => ({
                returning: () =>
                  Promise.resolve([{ id: "porg-existing", authKind: "oauth" }]),
              }),
            }),
          }),
        }),
    );

    const res = await installOne(ctx, {
      pluginType: "mcp_server",
      custom: customNone,
    });
    expect(res).toEqual({ id: "porg-existing", authKind: "oauth" });
  });
});

describe("plugin.org.install handler — audit event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
    mocks.detectOAuthProtected.mockResolvedValue(false);
  });

  it("returns the {orgListingId, authKind} output shape", async () => {
    mocks.detectOAuthProtected.mockResolvedValue(true);
    mockCustomUpsert("porg-handler-shape");
    const out = await handler(
      {
        pluginType: "mcp_server",
        custom: {
          name: "stripe-mcp",
          endpointUrl: "https://mcp.stripe.com",
          transport: "streamable-http",
          authKind: "none",
        },
      },
      ctx,
    );
    // The handler exposes the effective auth kind so the app can immediately
    // prompt the user to authenticate an OAuth-protected install.
    expect(out).toEqual({
      orgListingId: "porg-handler-shape",
      authKind: "oauth",
    });
  });

  it("emits plugin.installed on success with workspace scope (SOC2 audit trail)", async () => {
    mockCapabilityUpsert("porg-audited");
    const out = (await handler(
      { pluginType: "agent_capability", pluginId: "oxagen/media-video" },
      ctx,
    )) as { orgListingId: string; authKind: string };
    expect(out.orgListingId).toBe("porg-audited");
    expect(out.authKind).toBe("none");
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.installed",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        capability: "install_plugin",
        outcome: "success",
        requestId: "req-1",
      }),
    );
  });

  it("does NOT emit an audit event when install fails", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    await expect(
      handler(
        { pluginType: "agent_capability", pluginId: "oxagen/nonexistent" },
        ctx,
      ),
    ).rejects.toThrow("Unknown capability plugin");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});
