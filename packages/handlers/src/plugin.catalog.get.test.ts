import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  listServers: vi.fn(),
  getServerVersion: vi.fn(),
  deriveTransportTypes: vi.fn(),
  deriveAuthKind: vi.fn(),
  fetchAndRenderReadme: vi.fn(),
  isReadmeFresh: vi.fn(),
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
  fetchAndRenderReadme: mocks.fetchAndRenderReadme,
  isReadmeFresh: mocks.isReadmeFresh,
}));

import { handler } from "./plugin.catalog.get";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Typed once here so no call site needs an `as any` (and the accompanying
// eslint-disable) just to hand this fixture to the handler.
const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
} as unknown as CapabilityContext;

const mediaImageManifest = {
  id: "oxagen/media-image",
  name: "Image Generation",
  description:
    "Generate, create, analyze, and manage AI images within your workspace.",
  version: "1.0.0",
  pluginType: "agent_capability" as const,
  tier: "free" as const,
  visibility: "ga" as const,
  category: "media",
  icon: "image-plus",
  color: "#6366f1",
  contracts: ["generate_image"],
  scopes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no persistent readme cache in this live-lookup path, so
  // isReadmeFresh(null, …) always reports "stale" — matches production
  // behavior unless a test overrides it to prove the caching gate works.
  mocks.isReadmeFresh.mockReturnValue(false);
});

describe("plugin.catalog.get handler", () => {
  it("resolves a first-party Oxagen capability pack without touching registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue(mediaImageManifest);

    const result = (await handler(
      { name: "oxagen/media-image", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

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

  it("returns readmeHtml: null for a first-party pack (no repository to source from)", async () => {
    mocks.getOxagenPlugin.mockReturnValue(mediaImageManifest);

    const result = (await handler(
      { name: "oxagen/media-image", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.readmeHtml).toBeNull();
    expect(mocks.fetchAndRenderReadme).not.toHaveBeenCalled();
  });

  it("forwards icon+color from the manifest per the SHARED ICON DATA CONTRACT", async () => {
    mocks.getOxagenPlugin.mockReturnValue(mediaImageManifest);

    const result = (await handler(
      { name: "oxagen/media-image", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.icons).toEqual([{ src: "image-plus", color: "#6366f1" }]);
  });

  it("returns icons:[] for a first-party manifest without an icon field", async () => {
    const noIconManifest = {
      ...mediaImageManifest,
      icon: undefined,
      color: undefined,
    };
    mocks.getOxagenPlugin.mockReturnValue(noIconManifest);

    const result = (await handler(
      { name: "oxagen/media-image", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.icons).toEqual([]);
  });

  it("treats a hidden Oxagen pack as not-found and falls through to registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue({
      ...mediaImageManifest,
      visibility: "hidden",
    });
    // No enabled registries → not-found.
    mocks.withSystemDb.mockResolvedValue([]);

    await expect(
      handler({ name: "oxagen/media-image", version: "latest" }, ctx),
    ).rejects.toThrow(/not found/i);
  });

  it("throws a not-found error (not a generic 500) when there are no enabled registries", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([]);

    await expect(
      handler({ name: "@scope/some-mcp-server", version: "latest" }, ctx),
    ).rejects.toThrow(/catalog server not found/i);
  });

  it("resolves an MCP server live from an enabled registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([
      { id: "reg-1", baseUrl: "https://registry.example.com" },
    ]);
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
            remotes: [
              { url: "https://mcp.example.com", type: "streamable-http" },
            ],
          },
          _meta: { categories: ["search"] },
        },
      ],
    });
    mocks.deriveTransportTypes.mockReturnValue(["streamable-http"]);
    mocks.deriveAuthKind.mockReturnValue("none");

    const result = (await handler(
      { name: "@scope/brave-search", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      name: "@scope/brave-search",
      title: "Brave Search",
      version: "2.3.0",
      transportTypes: ["streamable-http"],
      authKind: "none",
      categories: ["search"],
    });
    // No repository on this fixture → the README pipeline must not be invoked.
    expect(mocks.fetchAndRenderReadme).not.toHaveBeenCalled();
    expect(result.readmeHtml).toBeNull();
  });

  it("wires the README pipeline: calls fetchAndRenderReadme when a repository is present", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([
      { id: "reg-1", baseUrl: "https://registry.example.com" },
    ]);
    const repository = {
      source: "github",
      url: "https://github.com/acme/brave-search",
    };
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
            remotes: [
              { url: "https://mcp.example.com", type: "streamable-http" },
            ],
            repository,
          },
          _meta: { categories: ["search"] },
        },
      ],
    });
    mocks.deriveTransportTypes.mockReturnValue(["streamable-http"]);
    mocks.deriveAuthKind.mockReturnValue("none");
    mocks.fetchAndRenderReadme.mockResolvedValue("<p>Hello README</p>");

    const result = (await handler(
      { name: "@scope/brave-search", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(mocks.fetchAndRenderReadme).toHaveBeenCalledWith(repository);
    expect(result.readmeHtml).toBe("<p>Hello README</p>");
  });

  it("is fail-safe: a README fetch failure does not fail the whole get, and returns without readmeHtml", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([
      { id: "reg-1", baseUrl: "https://registry.example.com" },
    ]);
    const repository = {
      source: "github",
      url: "https://github.com/acme/brave-search",
    };
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
            remotes: [],
            repository,
          },
          _meta: {},
        },
      ],
    });
    mocks.deriveTransportTypes.mockReturnValue([]);
    mocks.deriveAuthKind.mockReturnValue("none");
    mocks.fetchAndRenderReadme.mockRejectedValue(
      new Error("network unreachable"),
    );

    const result = (await handler(
      { name: "@scope/brave-search", version: "latest" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.name).toBe("@scope/brave-search");
    expect(result.readmeHtml).toBeNull();
  });

  it("respects the isReadmeFresh caching gate: skips fetchAndRenderReadme when a cache reports fresh", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([
      { id: "reg-1", baseUrl: "https://registry.example.com" },
    ]);
    const repository = {
      source: "github",
      url: "https://github.com/acme/brave-search",
    };
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
            remotes: [],
            repository,
          },
          _meta: {},
        },
      ],
    });
    mocks.deriveTransportTypes.mockReturnValue([]);
    mocks.deriveAuthKind.mockReturnValue("none");
    mocks.isReadmeFresh.mockReturnValue(true);

    await handler({ name: "@scope/brave-search", version: "latest" }, ctx);

    expect(mocks.fetchAndRenderReadme).not.toHaveBeenCalled();
  });

  it("throws not-found when the server is absent from every enabled registry", async () => {
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withSystemDb.mockResolvedValue([
      { id: "reg-1", baseUrl: "https://registry.example.com" },
    ]);
    mocks.listServers.mockResolvedValue({ servers: [] });

    await expect(
      handler({ name: "@scope/missing", version: "latest" }, ctx),
    ).rejects.toThrow(/catalog server not found/i);
  });
});
