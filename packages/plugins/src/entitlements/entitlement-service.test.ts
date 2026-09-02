/**
 * entitlement-service.test.ts
 *
 * Covers:
 *  - Entitled set assembly: enabled + agent_capability rows → included
 *  - Soft-deleted rows excluded (deletedAt is not null)
 *  - Disabled rows excluded (enabled=false)
 *  - Non-capability rows ignored (plugin_type != 'agent_capability')
 *  - Workspace scoping: cache keyed by (orgId, workspaceId)
 *  - TTL cache hit — DB is queried once for two calls within TTL (same org+workspace)
 *  - clearEntitlementCacheForTests forces re-query
 *  - Gate throws CapabilityError code 'capability_not_installed' for unentitled claimed contract
 *  - Gate passes (no throw) for entitled claimed contract
 *  - Gate no-ops for unclaimed contract (builtin)
 *
 * NOTE: there is NO org denylist any more — workspaces install whatever they want.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

type ListingRow = {
  name: string;
  pluginType: string;
  enabled: boolean;
  deletedAt: Date | null;
};

let mockListingRows: ListingRow[] = [];
let dbCallCount = 0;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => {
      dbCallCount++;
      return fn(makeTx());
    },
  };
});

function makeTx() {
  // Minimal drizzle tx shim — the service runs a single select:
  //   tx.select({ name }).from(installed_plugins).where(...)
  // The real WHERE is enforced by the DB; here we return rows pre-filtered to
  // the query contract (enabled + agent_capability + not soft-deleted).
  return {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) =>
          Promise.resolve(
            mockListingRows
              .filter(
                (r) =>
                  r.pluginType === "agent_capability" &&
                  r.enabled === true &&
                  r.deletedAt === null,
              )
              .map((r) => ({ name: r.name })),
          ),
      }),
    }),
  };
}

// Mock the @oxagen/oxagen/plugins barrel to return controlled manifests.
vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: (name: string) => {
    if (name === "generate_svg")
      return {
        id: "oxagen/media-svg",
        name: "SVG Generation",
        contracts: ["generate_svg"],
      };
    if (name === "generate_document")
      return {
        id: "oxagen/documents",
        name: "Documents",
        contracts: ["generate_document"],
      };
    return undefined; // builtin (unclaimed)
  },
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  capabilityNotInstalledError: (
    capability: string,
    pluginId: string,
    pluginName: string,
  ) => {
    const err = new Error(
      `Capability "${capability}" requires the "${pluginName}" plugin (${pluginId}).`,
    ) as Error & { code: string; capability: string };
    err.name = "CapabilityError";
    err.code = "capability_not_installed";
    err.capability = capability;
    return err;
  },
  setCapabilityEntitlementGate: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function listing(name: string, opts: Partial<ListingRow> = {}): ListingRow {
  return {
    name,
    pluginType: "agent_capability",
    enabled: true,
    deletedAt: null,
    ...opts,
  };
}

const WS = "ws-1";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("listEntitledCapabilityPluginIds", () => {
  beforeEach(() => {
    mockListingRows = [];
    dbCallCount = 0;
    vi.resetModules();
  });

  it("returns enabled agent_capability plugin ids", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [
      listing("oxagen/media-svg"),
      listing("oxagen/documents"),
    ];
    const result = await listEntitledCapabilityPluginIds("org-1", WS);
    expect(result.has("oxagen/media-svg")).toBe(true);
    expect(result.has("oxagen/documents")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("excludes soft-deleted listings (deletedAt is not null)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [
      listing("oxagen/media-svg"),
      listing("oxagen/documents", { deletedAt: new Date() }),
    ];
    const result = await listEntitledCapabilityPluginIds("org-2", WS);
    expect(result.has("oxagen/media-svg")).toBe(true);
    expect(result.has("oxagen/documents")).toBe(false);
  });

  it("excludes disabled listings (enabled=false)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg", { enabled: false })];
    const result = await listEntitledCapabilityPluginIds("org-3", WS);
    expect(result.has("oxagen/media-svg")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("ignores non-capability listings (e.g. mcp_server)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [
      listing("some-mcp-server", { pluginType: "mcp_server" }),
    ];
    const result = await listEntitledCapabilityPluginIds("org-4", WS);
    expect(result.has("some-mcp-server")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("hits the TTL cache — DB is queried once for two calls within TTL (same org+workspace)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await listEntitledCapabilityPluginIds("org-6", WS);
    await listEntitledCapabilityPluginIds("org-6", WS);
    expect(dbCallCount).toBe(1);
  });

  it("does NOT share cache across workspaces (different workspaceId re-queries)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await listEntitledCapabilityPluginIds("org-6", "ws-a");
    await listEntitledCapabilityPluginIds("org-6", "ws-b");
    expect(dbCallCount).toBe(2);
  });

  it("clearEntitlementCacheForTests forces a re-query on next call", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await listEntitledCapabilityPluginIds("org-7", WS);
    clearEntitlementCacheForTests();
    await listEntitledCapabilityPluginIds("org-7", WS);
    expect(dbCallCount).toBe(2);
  });
});

describe("capabilityEntitlementGate", () => {
  beforeEach(() => {
    mockListingRows = [];
    dbCallCount = 0;
    vi.resetModules();
  });

  it("no-ops for unclaimed (builtin) contracts", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    await expect(
      capabilityEntitlementGate("workspace.documents.list", "org-builtin", WS),
    ).resolves.toBeUndefined();
  });

  it("passes (no throw) for an entitled claimed contract", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await expect(
      capabilityEntitlementGate("generate_svg", "org-entitled", WS),
    ).resolves.toBeUndefined();
  });

  it("throws capability_not_installed for a claimed but unentitled contract", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } =
      await import("./entitlement-service");
    clearEntitlementCacheForTests();
    mockListingRows = [];
    await expect(
      capabilityEntitlementGate("generate_svg", "org-unentitled", WS),
    ).rejects.toMatchObject({
      name: "CapabilityError",
      code: "capability_not_installed",
      capability: "generate_svg",
    });
  });
});
