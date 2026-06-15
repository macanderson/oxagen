import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  listOxagenPlugins: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock("@oxagen/oxagen/plugins", () => ({
  listOxagenPlugins: mocks.listOxagenPlugins,
}));

import { handler } from "./plugin.catalog.browse";

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

/** Four manifests matching Phase 1 catalog: 3 ga + 1 preview + 1 hidden. */
const fakeManifests = [
  {
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
  },
  {
    id: "oxagen/media-image",
    name: "Image Generation",
    description: "Generate and manage AI images.",
    version: "1.0.0",
    tier: "free",
    visibility: "ga",
    category: "media",
    icon: "image",
    contracts: ["image.generate"],
    scopes: [],
  },
  {
    id: "oxagen/media-svg",
    name: "SVG Generation",
    description: "Generate scalable vector graphics.",
    version: "1.0.0",
    tier: "free",
    visibility: "ga",
    category: "media",
    icon: "shapes",
    contracts: ["svg.generate"],
    scopes: [],
  },
  {
    id: "oxagen/documents",
    name: "Document Generation",
    description: "Generate rich documents and PDFs.",
    version: "1.0.0",
    tier: "free",
    visibility: "ga",
    category: "documents",
    icon: "file-text",
    contracts: ["documents.generate"],
    scopes: [],
  },
  {
    id: "oxagen/hidden-plugin",
    name: "Hidden Plugin",
    description: "Should never appear in browse results.",
    version: "1.0.0",
    tier: "free",
    visibility: "hidden",
    category: "media",
    icon: undefined,
    contracts: ["hidden.do"],
    scopes: [],
  },
  {
    id: "oxagen/preview-plugin",
    name: "Preview Plugin",
    description: "Should be excluded from browse results.",
    version: "1.0.0",
    tier: "premium",
    visibility: "preview",
    category: "media",
    icon: undefined,
    contracts: ["preview.do"],
    scopes: [],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mock withSystemDb to return a set of already-installed plugin ids. */
function mockInstalledNames(names: string[]) {
  mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(names.map((name) => ({ name }))),
        }),
      }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("plugin.catalog.browse handler — capability path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
  });

  it("returns only ga manifests (4 items) — excludes hidden and preview", async () => {
    mockInstalledNames([]);
    const result = await handler({ pluginType: "capability", limit: 30, offset: 0 }, ctx) as {
      servers: Array<{ id: string; pluginType: string; visibility?: string }>;
      total: number;
    };
    expect(result.total).toBe(4);
    expect(result.servers).toHaveLength(4);
    expect(result.servers.every((s) => s.pluginType === "capability")).toBe(true);
    expect(result.servers.map((s) => s.id)).not.toContain("oxagen/hidden-plugin");
    expect(result.servers.map((s) => s.id)).not.toContain("oxagen/preview-plugin");
  });

  it("maps name to plugin id (stable install key), title to manifest.name", async () => {
    mockInstalledNames([]);
    const result = await handler({ pluginType: "capability", limit: 30, offset: 0 }, ctx) as {
      servers: Array<{ id: string; name: string; title: string; tier: string }>;
    };
    const video = result.servers.find((s) => s.id === "oxagen/media-video");
    expect(video).toBeDefined();
    expect(video!.name).toBe("oxagen/media-video"); // stable install key
    expect(video!.title).toBe("Video Generation");  // human-readable name
    expect(video!.tier).toBe("premium");
  });

  it("sets installed:true for already-installed plugins, false otherwise", async () => {
    mockInstalledNames(["oxagen/media-video", "oxagen/documents"]);
    const result = await handler({ pluginType: "capability", limit: 30, offset: 0 }, ctx) as {
      servers: Array<{ id: string; installed: boolean }>;
    };
    const video = result.servers.find((s) => s.id === "oxagen/media-video");
    const docs = result.servers.find((s) => s.id === "oxagen/documents");
    const img = result.servers.find((s) => s.id === "oxagen/media-image");
    expect(video!.installed).toBe(true);
    expect(docs!.installed).toBe(true);
    expect(img!.installed).toBe(false);
  });

  it("org-less browse (orgId '') reports nothing installed and never queries by org", async () => {
    // apps/app serves the global catalog route without org context; comparing
    // the uuid org_id column to "" would throw, so the handler must skip the
    // installed lookup entirely.
    const selectSpy = vi.fn();
    mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => {
          selectSpy();
          return {
            from: () => ({ where: () => Promise.resolve([]) }),
          };
        },
      }),
    );
    const result = await handler(
      { pluginType: "capability", limit: 30, offset: 0 },
      { ...ctx, orgId: "" },
    ) as { servers: Array<{ installed: boolean }> };
    expect(result.servers.length).toBeGreaterThan(0);
    expect(result.servers.every((s) => s.installed === false)).toBe(true);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("filters by search term (case-insensitive, matches id, name, description)", async () => {
    mockInstalledNames([]);
    const result = await handler(
      { pluginType: "capability", search: "video", limit: 30, offset: 0 },
      ctx,
    ) as { servers: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.id).toBe("oxagen/media-video");
  });

  it("search is case-insensitive", async () => {
    mockInstalledNames([]);
    const result = await handler(
      { pluginType: "capability", search: "DOCUMENT", limit: 30, offset: 0 },
      ctx,
    ) as { servers: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.id).toBe("oxagen/documents");
  });

  it("respects limit and offset pagination", async () => {
    mockInstalledNames([]);
    const page1 = await handler(
      { pluginType: "capability", limit: 2, offset: 0 },
      ctx,
    ) as { servers: unknown[]; total: number; nextOffset: number | null };
    expect(page1.total).toBe(4);
    expect(page1.servers).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);

    mockInstalledNames([]);
    const page2 = await handler(
      { pluginType: "capability", limit: 2, offset: 2 },
      ctx,
    ) as { servers: unknown[]; total: number; nextOffset: number | null };
    expect(page2.servers).toHaveLength(2);
    expect(page2.nextOffset).toBe(null); // no further pages
  });

  it("sets transportTypes:[], authKind:'none', icons:[] for capability entries", async () => {
    mockInstalledNames([]);
    const result = await handler({ pluginType: "capability", limit: 30, offset: 0 }, ctx) as {
      servers: Array<{ transportTypes: string[]; authKind: string; icons: unknown[] }>;
    };
    for (const s of result.servers) {
      expect(s.transportTypes).toEqual([]);
      expect(s.authKind).toBe("none");
      expect(s.icons).toEqual([]);
    }
  });

  it("returns empty results when search matches nothing", async () => {
    mockInstalledNames([]);
    const result = await handler(
      { pluginType: "capability", search: "xyznotfound", limit: 30, offset: 0 },
      ctx,
    ) as { servers: unknown[]; total: number; nextOffset: null };
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
    expect(result.nextOffset).toBe(null);
  });
});

describe("plugin.catalog.browse handler — catalog_server path (omitted pluginType)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
    // An empty/omitted-pluginType catalog with count < 5 fires a fire-and-forget
    // background registry sync via a SECOND withSystemDb(...).catch(...) call.
    // The per-test mockImplementationOnce handles the main query (the first
    // call); this default makes that background call resolve harmlessly so the
    // trailing .catch() has a promise to attach to.
    mocks.withSystemDb.mockResolvedValue(undefined);
  });

  /**
   * Helper: builds a mock tx that handles BOTH the rows query (with .orderBy)
   * and the count query (without .orderBy) inside the same withSystemDb callback.
   * The catalog browse handler runs both queries against the same tx object.
   */
  function makeCatalogTx(rows: unknown[], count: number) {
    let callCount = 0;
    return {
      select: () => {
        callCount++;
        if (callCount === 1) {
          // First select: rows query — chain includes orderBy/limit/offset
          return {
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => ({
                    offset: () => Promise.resolve(rows),
                  }),
                }),
              }),
            }),
          };
        }
        // Second select: count query — chain is select().from().where()
        return {
          from: () => ({
            where: () => Promise.resolve([{ count }]),
          }),
        };
      },
    };
  }

  it("does NOT call listOxagenPlugins when pluginType is omitted", async () => {
    mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeCatalogTx([], 0)),
    );

    await handler({ limit: 30, offset: 0 }, ctx);
    expect(mocks.listOxagenPlugins).not.toHaveBeenCalled();
  });

  it("does NOT mix capability entries into omitted-pluginType results", async () => {
    const fakeCatalogRow = {
      id: "cid-1",
      name: "my-mcp-server",
      title: "My MCP Server",
      description: "An MCP server.",
      icons: [],
      transportTypes: ["sse"],
      authKind: "none",
      categories: [],
      version: "1.0.0",
      publishedAt: new Date(),
      isLatest: true,
      status: "active",
      remotes: [],
    };

    mocks.withSystemDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeCatalogTx([fakeCatalogRow], 1)),
    );

    const result = await handler({ limit: 30, offset: 0 }, ctx) as {
      servers: Array<{ pluginType: string }>;
    };
    // No capability entries should appear
    expect(result.servers.every((s) => s.pluginType !== "capability")).toBe(true);
  });
});
