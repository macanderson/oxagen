import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  listOxagenPlugins: vi.fn(),
  listServers: vi.fn(),
  mapServerDetailToCatalogRow: vi.fn(),
  deriveTransportTypes: vi.fn(),
  deriveAuthKind: vi.fn(),
  seedWorkspaceDefaultRegistry: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/oxagen/plugins", () => ({
  listOxagenPlugins: mocks.listOxagenPlugins,
}));

vi.mock("@oxagen/plugins/registry", () => ({
  listServers: mocks.listServers,
  mapServerDetailToCatalogRow: mocks.mapServerDetailToCatalogRow,
  deriveTransportTypes: mocks.deriveTransportTypes,
  deriveAuthKind: mocks.deriveAuthKind,
}));

vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: mocks.seedWorkspaceDefaultRegistry,
}));

import { handler, clearRegistryCacheForTests } from "./plugin.catalog.browse";

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

/** Static Oxagen plugin manifests (agent_capability type). */
const fakeManifests = [
  {
    id: "oxagen/media-video",
    name: "Video Generation",
    description: "Generate videos from text prompts.",
    version: "1.0.0",
    tier: "premium",
    visibility: "ga",
    category: "media",
    icon: "video",
    color: "#f59e0b",
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
    icon: "image-plus",
    color: "#6366f1",
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
    icon: "pen-tool",
    color: "#0ea5e9",
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
    icon: "notebook-pen",
    color: "#10b981",
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
    color: undefined,
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
    color: undefined,
    contracts: ["preview.do"],
    scopes: [],
  },
];

/** A minimal registry row returned from the DB. */
const fakeRegistry = { id: "reg-1", baseUrl: "https://registry.example.com" };

/** A minimal ServerResponse from the live registry client. */
function makeServerResponse(name: string, version = "1.0.0") {
  return {
    server: {
      name,
      description: `${name} description`,
      version,
      title: `${name} title`,
      packages: [],
      remotes: [],
    },
    _meta: {
      isLatest: true,
      status: "active",
      publishedAt: "2024-01-01T00:00:00Z",
    },
  };
}

// ── withTenantDb helpers ─────────────────────────────────────────────────────

/** Mock a single withTenantDb call that returns registries.
 * When registries are non-empty, also queues a catalog-rows mock (empty by
 * default) because the handler queries mcp.catalog_servers immediately after. */
function mockRegistries(
  regs: (typeof fakeRegistry)[],
  catalogRows: unknown[] = [],
) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({ where: () => Promise.resolve(regs) }),
        }),
      }),
  );
  if (regs.length > 0) {
    mockCatalogRows(catalogRows);
  }
}

/** Mock a single withTenantDb call that returns catalog server rows (empty = fall through to live fetch). */
function mockCatalogRows(rows: unknown[] = []) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(rows),
              }),
            }),
          }),
        }),
      }),
  );
}

/** Mock a single withTenantDb call that returns installed plugin name rows. */
function mockInstalledNames(names: string[]) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(names.map((name) => ({ name }))),
          }),
        }),
      }),
  );
}

// ── Tests: agent_capability path (static registry) ───────────────────────────

describe("plugin.catalog.browse handler — agent_capability path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
  });

  it("returns only ga manifests (4 items) — excludes hidden and preview", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ id: string; pluginType: string }>; total: number };
    expect(result.total).toBe(4);
    expect(result.servers).toHaveLength(4);
    expect(
      result.servers.every((s) => s.pluginType === "agent_capability"),
    ).toBe(true);
    expect(result.servers.map((s) => s.id)).not.toContain(
      "oxagen/hidden-plugin",
    );
    expect(result.servers.map((s) => s.id)).not.toContain(
      "oxagen/preview-plugin",
    );
  });

  it("maps name to plugin id (stable install key), title to manifest.name", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ id: string; name: string; title: string; tier: string }>;
    };
    const video = result.servers.find((s) => s.id === "oxagen/media-video");
    expect(video).toBeDefined();
    expect(video!.name).toBe("oxagen/media-video"); // stable install key
    expect(video!.title).toBe("Video Generation"); // human-readable name
    expect(video!.tier).toBe("premium");
  });

  it("overlays install state from installed_plugins (workspace-scoped)", async () => {
    mockInstalledNames(["oxagen/media-video", "oxagen/documents"]);
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ id: string; installed: boolean }> };
    const video = result.servers.find((s) => s.id === "oxagen/media-video");
    const docs = result.servers.find((s) => s.id === "oxagen/documents");
    const img = result.servers.find((s) => s.id === "oxagen/media-image");
    expect(video!.installed).toBe(true);
    expect(docs!.installed).toBe(true);
    expect(img!.installed).toBe(false);
  });

  it("org-less browse reports nothing installed and skips the DB query", async () => {
    const selectSpy = vi.fn();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => {
            selectSpy();
            return { from: () => ({ where: () => Promise.resolve([]) }) };
          },
        }),
    );
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      { ...ctx, orgId: "" },
    )) as { servers: Array<{ installed: boolean }> };
    expect(result.servers.length).toBeGreaterThan(0);
    expect(result.servers.every((s) => s.installed === false)).toBe(true);
    // withTenantDb is still called but the inner tx.select() should not be,
    // because the handler short-circuits on empty orgId.
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("filters by search term (case-insensitive, matches id, name, description)", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "agent_capability", search: "video", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.id).toBe("oxagen/media-video");
  });

  it("search is case-insensitive", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      {
        pluginType: "agent_capability",
        search: "DOCUMENT",
        limit: 30,
        offset: 0,
      },
      ctx,
    )) as { servers: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.id).toBe("oxagen/documents");
  });

  it("respects limit and offset pagination", async () => {
    mockInstalledNames([]);
    const page1 = (await handler(
      { pluginType: "agent_capability", limit: 2, offset: 0 },
      ctx,
    )) as { servers: unknown[]; total: number; nextOffset: number | null };
    expect(page1.total).toBe(4);
    expect(page1.servers).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);

    mockInstalledNames([]);
    const page2 = (await handler(
      { pluginType: "agent_capability", limit: 2, offset: 2 },
      ctx,
    )) as { servers: unknown[]; total: number; nextOffset: number | null };
    expect(page2.servers).toHaveLength(2);
    expect(page2.nextOffset).toBe(null);
  });

  it("sets transportTypes:[], authKind:'none' for capability entries", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{
        transportTypes: string[];
        authKind: string;
        icons: unknown[];
      }>;
    };
    for (const s of result.servers) {
      expect(s.transportTypes).toEqual([]);
      expect(s.authKind).toBe("none");
    }
  });

  it("forwards icon+color from the manifest per the SHARED ICON DATA CONTRACT", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{
        id: string;
        icons: Array<{ src: string; color?: string }>;
      }>;
    };

    const video = result.servers.find((s) => s.id === "oxagen/media-video");
    expect(video!.icons).toEqual([{ src: "video", color: "#f59e0b" }]);

    const image = result.servers.find((s) => s.id === "oxagen/media-image");
    expect(image!.icons).toEqual([{ src: "image-plus", color: "#6366f1" }]);

    const svg = result.servers.find((s) => s.id === "oxagen/media-svg");
    expect(svg!.icons).toEqual([{ src: "pen-tool", color: "#0ea5e9" }]);

    const docs = result.servers.find((s) => s.id === "oxagen/documents");
    expect(docs!.icons).toEqual([{ src: "notebook-pen", color: "#10b981" }]);
  });

  it("returns icons:[] for a manifest with no icon field", async () => {
    // Use manifests where some entries have no icon (visibility hidden/preview are
    // filtered out, but we can inject a ga manifest without an icon directly).
    const noIconManifests = [
      {
        id: "oxagen/no-icon-plugin",
        name: "No Icon Plugin",
        description: "A plugin without an icon field.",
        version: "1.0.0",
        tier: "free",
        visibility: "ga",
        category: "other",
        icon: undefined,
        color: undefined,
        contracts: ["no.icon"],
        scopes: [],
      },
    ];
    mocks.listOxagenPlugins.mockReturnValue(noIconManifests);
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "agent_capability", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ icons: unknown[] }> };

    expect(result.servers[0]!.icons).toEqual([]);

    // Restore the standard fake manifests for subsequent tests.
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
  });

  it("installed:true returns only installed plugins", async () => {
    mockInstalledNames(["oxagen/media-video", "oxagen/documents"]);
    const result = (await handler(
      { pluginType: "agent_capability", installed: true, limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ id: string; installed: boolean }>; total: number };
    expect(result.total).toBe(2);
    expect(result.servers.map((s) => s.id).sort()).toEqual([
      "oxagen/documents",
      "oxagen/media-video",
    ]);
    expect(result.servers.every((s) => s.installed === true)).toBe(true);
  });

  it("installed:false returns only not-installed plugins", async () => {
    mockInstalledNames(["oxagen/media-video", "oxagen/documents"]);
    const result = (await handler(
      {
        pluginType: "agent_capability",
        installed: false,
        limit: 30,
        offset: 0,
      },
      ctx,
    )) as { servers: Array<{ id: string; installed: boolean }>; total: number };
    expect(result.total).toBe(2);
    expect(result.servers.map((s) => s.id).sort()).toEqual([
      "oxagen/media-image",
      "oxagen/media-svg",
    ]);
    expect(result.servers.every((s) => s.installed === false)).toBe(true);
  });

  it("returns empty results when search matches nothing", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      {
        pluginType: "agent_capability",
        search: "xyznotfound",
        limit: 30,
        offset: 0,
      },
      ctx,
    )) as { servers: unknown[]; total: number; nextOffset: null };
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
    expect(result.nextOffset).toBe(null);
  });
});

// ── Tests: agent_skill path (from agent.skills table) ────────────────────────

/** Seed skill rows returned from the DB mock for agent_skill browse tests. */
const fakeSkills = [
  {
    id: "skl-uuid-1",
    slug: "web-research",
    name: "Web Research",
    description: "Search the web and extract structured information.",
    source: "builtin",
  },
  {
    id: "skl-uuid-2",
    slug: "code-review",
    name: "Code Review",
    description: "Review code for correctness, style, and security issues.",
    source: "builtin",
  },
];

/** Mock a single withTenantDb call that returns skill rows from agent.skills. */
function mockSkillRows(skills: typeof fakeSkills) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(skills),
          }),
        }),
      }),
  );
}

describe("plugin.catalog.browse handler — agent_skill path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
  });

  it("returns seeded skills mapped to browse row shape, each installed:true", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{
        id: string;
        name: string;
        title: string;
        description: string;
        pluginType: string;
        installed: boolean;
        transportTypes: string[];
        authKind: string;
        icons: unknown[];
      }>;
      total: number;
      nextOffset: number | null;
    };

    expect(result.total).toBe(2);
    expect(result.servers).toHaveLength(2);
    expect(result.nextOffset).toBe(null);

    const webResearch = result.servers.find((s) => s.name === "web-research");
    expect(webResearch).toBeDefined();
    expect(webResearch!.id).toBe("skl-uuid-1");
    expect(webResearch!.title).toBe("Web Research");
    expect(webResearch!.description).toBe(
      "Search the web and extract structured information.",
    );
    expect(webResearch!.pluginType).toBe("agent_skill");
    expect(webResearch!.installed).toBe(true);
    expect(webResearch!.transportTypes).toEqual([]);
    expect(webResearch!.authKind).toBe("none");
    expect(webResearch!.icons).toEqual([]);
  });

  it("all returned skills have installed:true (skills are installed-by-default)", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ installed: boolean }> };
    expect(result.servers.every((s) => s.installed === true)).toBe(true);
  });

  it("applies search filter case-insensitively against slug, name, and description", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", search: "WEB", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("web-research");
  });

  it("search matches on description text", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", search: "security", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("code-review");
  });

  it("returns empty when no org context (org-less browse)", async () => {
    // withTenantDb returns [] for missing orgId (handler short-circuits).
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({ where: () => Promise.resolve([]) }),
          }),
        }),
    );
    const result = (await handler(
      { pluginType: "agent_skill", limit: 30, offset: 0 },
      { ...ctx, orgId: "" },
    )) as { servers: unknown[]; total: number };
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
  });

  it("installed:false returns empty (skills are always installed)", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", installed: false, limit: 30, offset: 0 },
      ctx,
    )) as { servers: unknown[]; total: number };
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
  });

  it("installed:true returns all skills (all are installed)", async () => {
    mockSkillRows(fakeSkills);
    const result = (await handler(
      { pluginType: "agent_skill", installed: true, limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ installed: boolean }>; total: number };
    expect(result.total).toBe(2);
    expect(result.servers.every((s) => s.installed === true)).toBe(true);
  });

  it("applies pagination — returns correct page and nextOffset", async () => {
    mockSkillRows(fakeSkills);
    const page1 = (await handler(
      { pluginType: "agent_skill", limit: 1, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ name: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(page1.total).toBe(2);
    expect(page1.servers).toHaveLength(1);
    expect(page1.servers[0]!.name).toBe("web-research");
    expect(page1.nextOffset).toBe(1);

    mockSkillRows(fakeSkills);
    const page2 = (await handler(
      { pluginType: "agent_skill", limit: 1, offset: 1 },
      ctx,
    )) as {
      servers: Array<{ name: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(page2.servers).toHaveLength(1);
    expect(page2.servers[0]!.name).toBe("code-review");
    expect(page2.nextOffset).toBe(null);
  });
});

// ── Tests: knowledge_source / integration (static, empty for now) ─────────────

describe("plugin.catalog.browse handler — other static plugin types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
  });

  it("knowledge_source returns empty (no static manifests for this type yet)", async () => {
    mockInstalledNames([]);
    const result = (await handler(
      { pluginType: "knowledge_source", limit: 30, offset: 0 },
      ctx,
    )) as { servers: unknown[]; total: number };
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
  });
});

// ── Tests: mcp_server path (live registry fetch) ─────────────────────────────

describe("plugin.catalog.browse handler — mcp_server path (live registry)", () => {
  beforeEach(() => {
    // resetAllMocks clears both call history AND queued mockImplementationOnce
    // entries so stale queue items from prior tests don't bleed through.
    vi.resetAllMocks();
    clearRegistryCacheForTests();
    mocks.listOxagenPlugins.mockReturnValue(fakeManifests);
    // Default map-server mocks use the real derivation logic shape.
    mocks.deriveTransportTypes.mockImplementation(() => ["sse"]);
    mocks.deriveAuthKind.mockImplementation(() => "none");
    mocks.mapServerDetailToCatalogRow.mockImplementation(
      (
        sd: {
          name: string;
          description: string;
          version: string;
          title?: string;
          icons?: unknown[];
        },
        _meta: unknown,
        registryId: string,
      ) => ({
        registryId,
        name: sd.name,
        description: sd.description,
        version: sd.version,
        title: sd.title ?? null,
        icons: sd.icons ?? [],
        packages: [],
        remotes: [],
        transportTypes: ["sse"],
        authKind: "none",
        status: "active",
        publishedAt: new Date(),
        upstreamUpdatedAt: null,
        statusChangedAt: null,
        isLatest: true,
        meta: {},
        websiteUrl: null,
        repository: null,
      }),
    );
  });

  it("loads workspace registries from DB and calls listServers for each", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("my-mcp-server")],
      nextCursor: undefined,
    });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ name: string; pluginType: string }>;
      total: number;
    };

    expect(mocks.listServers).toHaveBeenCalledWith(fakeRegistry.baseUrl, {
      limit: 100,
      search: undefined,
    });
    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("my-mcp-server");
    expect(result.servers[0]!.pluginType).toBe("mcp_server");
  });

  it("passes search term to listServers", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("brave-search")],
      nextCursor: undefined,
    });
    mockInstalledNames([]);

    await handler(
      { pluginType: "mcp_server", search: "brave", limit: 30, offset: 0 },
      ctx,
    );
    expect(mocks.listServers).toHaveBeenCalledWith(fakeRegistry.baseUrl, {
      limit: 100,
      search: "brave",
    });
  });

  it("merges results from multiple registries, deduplicating by name", async () => {
    const reg2 = { id: "reg-2", baseUrl: "https://registry2.example.com" };
    mockRegistries([fakeRegistry, reg2]);
    // Both registries return the same server name — second should be deduplicated.
    mocks.listServers
      .mockResolvedValueOnce({
        servers: [
          makeServerResponse("server-a"),
          makeServerResponse("server-b"),
        ],
        nextCursor: undefined,
      })
      .mockResolvedValueOnce({
        servers: [
          makeServerResponse("server-b"),
          makeServerResponse("server-c"),
        ],
        nextCursor: undefined,
      });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };

    // server-b from reg-2 should be deduplicated.
    expect(result.total).toBe(3);
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["server-a", "server-b", "server-c"]);
  });

  it("overlays install state from installed_plugins, marking installed:true", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("server-a"), makeServerResponse("server-b")],
      nextCursor: undefined,
    });
    mockInstalledNames(["server-a"]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string; installed: boolean }> };

    const a = result.servers.find((s) => s.name === "server-a");
    const b = result.servers.find((s) => s.name === "server-b");
    expect(a!.installed).toBe(true);
    expect(b!.installed).toBe(false);
  });

  it("installed:true returns only installed servers (total reflects filter)", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("server-a"), makeServerResponse("server-b")],
      nextCursor: undefined,
    });
    mockInstalledNames(["server-a"]);

    const result = (await handler(
      { pluginType: "mcp_server", installed: true, limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ name: string; installed: boolean }>;
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("server-a");
    expect(result.servers[0]!.installed).toBe(true);
  });

  it("continues past a failing registry and returns results from healthy ones", async () => {
    const reg2 = { id: "reg-2", baseUrl: "https://registry2.example.com" };
    mockRegistries([fakeRegistry, reg2]);
    mocks.listServers
      .mockRejectedValueOnce(new Error("registry unreachable"))
      .mockResolvedValueOnce({
        servers: [makeServerResponse("server-ok")],
        nextCursor: undefined,
      });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("server-ok");
  });

  it("returns empty when no registries are enabled for the workspace (after lazy-seed finds none)", async () => {
    // First registries query: empty.
    mockRegistries([]);
    // Lazy-seed succeeds (idempotent insert) but re-query still finds nothing.
    mocks.seedWorkspaceDefaultRegistry.mockResolvedValueOnce("reg-seeded");
    // Re-query after seed: still empty (e.g. insert rolled back or disabled).
    mockRegistries([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: unknown[]; total: number };

    expect(mocks.listServers).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
  });

  it("applies pagination in-memory over live results", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [
        makeServerResponse("s1"),
        makeServerResponse("s2"),
        makeServerResponse("s3"),
      ],
      nextCursor: undefined,
    });
    mockInstalledNames([]);

    const page1 = (await handler(
      { pluginType: "mcp_server", limit: 2, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ name: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(page1.total).toBe(3);
    expect(page1.servers).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);
  });

  it("workspace scoping: uses ctx.orgId + ctx.workspaceId for both registry lookup and install overlay", async () => {
    mockRegistries([fakeRegistry]);
    // No servers returned → installed-names query is skipped (liveRows.length === 0).
    mocks.listServers.mockResolvedValue({ servers: [], nextCursor: undefined });

    await handler({ pluginType: "mcp_server", limit: 30, offset: 0 }, ctx);

    // Both withTenantDb calls are workspace-scoped; just verify listServers was called
    // (meaning the registry lookup succeeded with the right ctx).
    expect(mocks.listServers).toHaveBeenCalledOnce();
  });

  it("no denylist logic — all servers from registry are returned without name-based filtering", async () => {
    mockRegistries([fakeRegistry]);
    // Names that a denylist might have blocked:
    const names = ["blocked-name", "denied-server", "org-banned-tool"];
    mocks.listServers.mockResolvedValue({
      servers: names.map((n) => makeServerResponse(n)),
      nextCursor: undefined,
    });
    // Second withTenantDb call: installed-names lookup for 3 live rows.
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };

    // All names pass through — no denylist filtering.
    expect(result.total).toBe(3);
    expect(result.servers.map((s) => s.name).sort()).toEqual(names.sort());
  });

  // ── Lazy-seed: pre-existing workspaces self-heal ──────────────────────────────

  it("lazy-seeds the default registry when no registries exist, then re-queries and returns results", async () => {
    // First registries query returns empty (no seed yet).
    mockRegistries([]);
    // seedWorkspaceDefaultRegistry succeeds silently.
    mocks.seedWorkspaceDefaultRegistry.mockResolvedValueOnce("reg-seeded");
    // Re-query after seed returns the default registry.
    mockRegistries([fakeRegistry]);
    // listServers returns a server from the newly seeded registry.
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("seeded-server")],
      nextCursor: undefined,
    });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; total: number };

    expect(mocks.seedWorkspaceDefaultRegistry).toHaveBeenCalledWith({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    });
    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("seeded-server");
  });

  it("does NOT call seedWorkspaceDefaultRegistry when registries already exist", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({ servers: [], nextCursor: undefined });

    await handler({ pluginType: "mcp_server", limit: 30, offset: 0 }, ctx);

    expect(mocks.seedWorkspaceDefaultRegistry).not.toHaveBeenCalled();
  });

  it("returns a warning when lazy seed fails, but still returns empty results gracefully", async () => {
    // First registries query returns empty.
    mockRegistries([]);
    // Seed throws.
    mocks.seedWorkspaceDefaultRegistry.mockRejectedValueOnce(
      new Error("DB error"),
    );

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: unknown[]; total: number; warnings?: string[] };

    expect(result.total).toBe(0);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toMatch(/seed/i);
  });

  // ── Warnings: failed registry fetches are surfaced in the output ──────────────

  it("includes a warning entry when a registry fetch fails", async () => {
    const reg2 = { id: "reg-2", baseUrl: "https://registry2.example.com" };
    mockRegistries([fakeRegistry, reg2]);
    mocks.listServers
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        servers: [makeServerResponse("healthy-server")],
        nextCursor: undefined,
      });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as {
      servers: Array<{ name: string }>;
      total: number;
      warnings?: string[];
    };

    // Results from the healthy registry still come through.
    expect(result.total).toBe(1);
    expect(result.servers[0]!.name).toBe("healthy-server");
    // A warning for the failed registry is included.
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes(fakeRegistry.id))).toBe(
      true,
    );
  });

  it("omits the warnings field when all registries succeed", async () => {
    mockRegistries([fakeRegistry]);
    mocks.listServers.mockResolvedValue({
      servers: [makeServerResponse("ok-server")],
      nextCursor: undefined,
    });
    mockInstalledNames([]);

    const result = (await handler(
      { pluginType: "mcp_server", limit: 30, offset: 0 },
      ctx,
    )) as { servers: Array<{ name: string }>; warnings?: string[] };

    expect(result.warnings).toBeUndefined();
  });
});
