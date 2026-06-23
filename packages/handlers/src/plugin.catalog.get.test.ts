import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  listServers: vi.fn(),
  getServerVersion: vi.fn(),
  deriveTransportTypes: vi.fn(),
  deriveAuthKind: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

vi.mock("@oxagen/plugins/registry", () => ({
  listServers: mocks.listServers,
  getServerVersion: mocks.getServerVersion,
  deriveTransportTypes: mocks.deriveTransportTypes,
  deriveAuthKind: mocks.deriveAuthKind,
}));

import { handler } from "./plugin.catalog.get";

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

const mediaImageManifest = {
  id: "oxagen/media-image",
  name: "Image Generation",
  description: "Generate, create, analyze, and manage AI images within your workspace.",
  version: "1.0.0",
  pluginType: "agent_capability" as const,
  tier: "free" as const,
  visibility: "ga" as const,
  category: "media",
  icon: "image-plus",
  color: "#6366f1",
  contracts: ["image.generate"],
  scopes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plugin.catalog.get handler", () => {
  it("resolves a first-party Oxagen capability pack without touching registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue(mediaImageManifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await handler({ name: "oxagen/media-image", version: "latest" }, ctx as any)) as Record<string, unknown>;

    expect(result).toMatchObject({
      name: "oxagen/media-image",
      title: "Image Generation",
      description: mediaImageManifest.description,
      version: "1.0.0",
      authKind: "none",
      categories: ["media"],
      packages: [],
      remotes: [],
      transportTypes: [],
    });
    // The registry path must never be reached for a first-party pack.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.listServers).not.toHaveBeenCalled();
  });

  it("forwards icon+color from the manifest per the SHARED ICON DATA CONTRACT", async () => {
    mocks.getOxagenPlugin.mockReturnValue(mediaImageManifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await handler({ name: "oxagen/media-image", version: "latest" }, ctx as any)) as Record<string, unknown>;

    expect(result.icons).toEqual([{ src: "image-plus", color: "#6366f1" }]);
  });

  it("returns icons:[] for a first-party manifest without an icon field", async () => {
    const noIconManifest = { ...mediaImageManifest, icon: undefined, color: undefined };
    mocks.getOxagenPlugin.mockReturnValue(noIconManifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await handler({ name: "oxagen/media-image", version: "latest" }, ctx as any)) as Record<string, unknown>;

    expect(result.icons).toEqual([]);
  });

  it("treats a hidden Oxagen pack as not-found and falls through to registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue({ ...mediaImageManifest, visibility: "hidden" });
    // No enabled registries → not-found.
    mocks.withSystemDb.mockResolvedValue([]);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({ name: "oxagen/media-image", version: "latest" }, ctx as any),
    ).rejects.toThrow(/not found/i);
  });

  it("throws a not-found error (not a generic 500) when there are no enabled registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([]);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({ name: "@scope/some-mcp-server", version: "latest" }, ctx as any),
    ).rejects.toThrow(/catalog server not found/i);
  });

  it("resolves an MCP server live from an enabled registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([{ id: "reg-1", baseUrl: "https://registry.example.com" }]);
    mocks.listServers.mockResolvedValue({
      servers: [
        {
          server: {
            name: "@scope/brave-search",
            title: "Brave Search",
            description: "Search the web.",
            version: "2.3.0",
            icons: [],
            packages: [],
            remotes: [{ url: "https://mcp.example.com", type: "streamable-http" }],
          },
          _meta: { categories: ["search"] },
        },
      ],
    });
    mocks.deriveTransportTypes.mockReturnValue(["streamable-http"]);
    mocks.deriveAuthKind.mockReturnValue("none");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await handler({ name: "@scope/brave-search", version: "latest" }, ctx as any)) as Record<string, unknown>;

    expect(result).toMatchObject({
      name: "@scope/brave-search",
      title: "Brave Search",
      version: "2.3.0",
      transportTypes: ["streamable-http"],
      authKind: "none",
      categories: ["search"],
    });
  });

  it("throws not-found when the server is absent from every enabled registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([{ id: "reg-1", baseUrl: "https://registry.example.com" }]);
    mocks.listServers.mockResolvedValue({ servers: [] });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({ name: "@scope/missing", version: "latest" }, ctx as any),
    ).rejects.toThrow(/catalog server not found/i);
  });
});
