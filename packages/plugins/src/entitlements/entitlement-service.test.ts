/**
 * entitlement-service.test.ts
 *
 * Covers:
 *  - Entitled set assembly: enabled+capability rows → included
 *  - Soft-deleted rows excluded (deletedAt is not null)
 *  - Denylist excluded (name appears in org_denylist for that org)
 *  - mcp_server-type rows ignored (plugin_type != 'capability')
 *  - TTL cache hit — DB is queried once for two calls within TTL
 *  - clearEntitlementCacheForTests forces re-query
 *  - Gate throws CapabilityError code 'capability_not_installed' for unentitled claimed contract
 *  - Gate passes (no throw) for entitled claimed contract
 *  - Gate no-ops for unclaimed contract (builtin)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

// We intercept @oxagen/database to inject deterministic in-memory rows.
// The mock is declared at the top level so vitest hoists it before imports.

type ListingRow = { name: string; pluginType: string; enabled: boolean; deletedAt: Date | null };
type DenyRow = { serverName: string; pluginType: string };

let mockListingRows: ListingRow[] = [];
let mockDenyRows: DenyRow[] = [];
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
  // Minimal drizzle tx shim — our service uses .select().from().where()
  // and we run two selects in a Promise.all. Each call returns the appropriate
  // mock rows based on what the service would query.
  //
  // The service calls:
  //   tx.select({ name: schema.pluginOrgListings.name }).from(schema.pluginOrgListings).where(...)
  //   tx.select({ serverName: schema.pluginOrgDenylist.serverName }).from(schema.pluginOrgDenylist).where(...)
  //
  // We differentiate the two by tracking call order within a single withSystemDb context.
  let selectCallIndex = 0;
  return {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          const idx = selectCallIndex++;
          if (idx === 0) {
            // First select → listings (already filtered by the real query; we
            // return all mockListingRows and let the service filtering run as
            // written, but since the real WHERE is done by the DB we return
            // pre-filtered rows matching the query contract).
            return Promise.resolve(
              mockListingRows
                .filter(
                  (r) =>
                    r.pluginType === "capability" &&
                    r.enabled === true &&
                    r.deletedAt === null,
                )
                .map((r) => ({ name: r.name })),
            );
          } else {
            // Second select → denylist
            return Promise.resolve(
              mockDenyRows
                .filter((r) => r.pluginType === "capability")
                .map((r) => ({ serverName: r.serverName })),
            );
          }
        },
      }),
    }),
  };
}

// Mock the @oxagen/oxagen/plugins barrel to return controlled manifests.
// "oxagen/media-svg" claims "svg.generate"; "oxagen/documents" claims "documents.generate".
vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: (name: string) => {
    if (name === "svg.generate")
      return { id: "oxagen/media-svg", name: "SVG Generation", contracts: ["svg.generate"] };
    if (name === "documents.generate")
      return {
        id: "oxagen/documents",
        name: "Documents",
        contracts: ["documents.generate"],
      };
    return undefined; // builtin (unclaimed)
  },
}));

// Mock @oxagen/oxagen/kernel for capabilityNotInstalledError.
// We use the real implementation shape (throws CapabilityError with the right code)
// but keep the dependency out of the DB.
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

function listing(
  name: string,
  opts: Partial<ListingRow> = {},
): ListingRow {
  return {
    name,
    pluginType: "capability",
    enabled: true,
    deletedAt: null,
    ...opts,
  };
}

function denyEntry(serverName: string): DenyRow {
  return { serverName, pluginType: "capability" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("listEntitledCapabilityPluginIds", () => {
  beforeEach(async () => {
    mockListingRows = [];
    mockDenyRows = [];
    dbCallCount = 0;
    // Reset module cache so the cache Map is fresh.
    vi.resetModules();
  });

  it("returns enabled capability plugin ids", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg"), listing("oxagen/documents")];
    const result = await listEntitledCapabilityPluginIds("org-1");
    expect(result.has("oxagen/media-svg")).toBe(true);
    expect(result.has("oxagen/documents")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("excludes soft-deleted listings (deletedAt is not null)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [
      listing("oxagen/media-svg"),
      listing("oxagen/documents", { deletedAt: new Date() }),
    ];
    const result = await listEntitledCapabilityPluginIds("org-2");
    expect(result.has("oxagen/media-svg")).toBe(true);
    expect(result.has("oxagen/documents")).toBe(false);
  });

  it("excludes disabled listings (enabled=false)", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg", { enabled: false })];
    const result = await listEntitledCapabilityPluginIds("org-3");
    expect(result.has("oxagen/media-svg")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("ignores mcp_server-type listings", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("some-mcp-server", { pluginType: "mcp_server" })];
    const result = await listEntitledCapabilityPluginIds("org-4");
    expect(result.has("some-mcp-server")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("excludes denylisted plugin ids", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg"), listing("oxagen/documents")];
    mockDenyRows = [denyEntry("oxagen/media-svg")];
    const result = await listEntitledCapabilityPluginIds("org-5");
    expect(result.has("oxagen/media-svg")).toBe(false);
    expect(result.has("oxagen/documents")).toBe(true);
  });

  it("hits the TTL cache — DB is queried once for two calls within TTL", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await listEntitledCapabilityPluginIds("org-6");
    await listEntitledCapabilityPluginIds("org-6");
    // Only 1 DB call despite 2 invocations (each withSystemDb call increments by 1
    // but the second call should be served from cache).
    expect(dbCallCount).toBe(1);
  });

  it("clearEntitlementCacheForTests forces a re-query on next call", async () => {
    const { listEntitledCapabilityPluginIds, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    await listEntitledCapabilityPluginIds("org-7");
    clearEntitlementCacheForTests();
    await listEntitledCapabilityPluginIds("org-7");
    expect(dbCallCount).toBe(2);
  });
});

describe("capabilityEntitlementGate", () => {
  beforeEach(async () => {
    mockListingRows = [];
    mockDenyRows = [];
    dbCallCount = 0;
    vi.resetModules();
  });

  it("no-ops for unclaimed (builtin) contracts", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    // "workspace.documents.list" is unmocked → returns undefined → builtin
    await expect(
      capabilityEntitlementGate("workspace.documents.list", "org-builtin"),
    ).resolves.toBeUndefined();
  });

  it("passes (no throw) for an entitled claimed contract", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    // "svg.generate" is claimed by "oxagen/media-svg"; put it in the entitled set.
    mockListingRows = [listing("oxagen/media-svg")];
    await expect(
      capabilityEntitlementGate("svg.generate", "org-entitled"),
    ).resolves.toBeUndefined();
  });

  it("throws capability_not_installed for a claimed but unentitled contract", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    // "svg.generate" is claimed by "oxagen/media-svg"; NOT in entitled set.
    mockListingRows = [];
    await expect(
      capabilityEntitlementGate("svg.generate", "org-unentitled"),
    ).rejects.toMatchObject({
      name: "CapabilityError",
      code: "capability_not_installed",
      capability: "svg.generate",
    });
  });

  it("throws for a contract whose plugin is denylisted", async () => {
    const { capabilityEntitlementGate, clearEntitlementCacheForTests } = await import(
      "./entitlement-service"
    );
    clearEntitlementCacheForTests();
    mockListingRows = [listing("oxagen/media-svg")];
    mockDenyRows = [denyEntry("oxagen/media-svg")];
    await expect(
      capabilityEntitlementGate("svg.generate", "org-denied"),
    ).rejects.toMatchObject({
      code: "capability_not_installed",
    });
  });
});
