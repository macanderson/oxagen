import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  loadBuiltInSchema: vi.fn(),
  getOxagenPlugin: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/ingestion/connector-schema-loader", () => ({
  loadBuiltInSchema: mocks.loadBuiltInSchema,
}));
vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pluginVersionListHandler } from "./plugin.version.list";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type HistoryRow = {
  pluginVersion: string;
  schemaVersion: string;
  cachedAt: Date;
  schema: Record<string, unknown> | null;
};

function setup(opts: {
  builtIn?: { metadata: { version: string; schemaVersion: string } } | null;
  manifest?: { version: string };
  history: HistoryRow[];
  installed: boolean;
}) {
  mocks.loadBuiltInSchema.mockReturnValue(opts.builtIn ?? null);
  mocks.getOxagenPlugin.mockReturnValue(opts.manifest);
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: (arg: Record<string, unknown>) => {
          if ("pluginVersion" in arg) {
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => Promise.resolve(opts.history),
                  }),
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve(opts.installed ? [{ id: "x" }] : []),
              }),
            }),
          };
        },
      }),
  );
}

const D1 = new Date("2026-05-01T00:00:00.000Z");
const D2 = new Date("2026-06-01T00:00:00.000Z");

describe("plugin.version.list handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 404 for a plugin that is neither a built-in connector nor a registry manifest", async () => {
    setup({
      builtIn: null,
      manifest: undefined,
      history: [],
      installed: false,
    });
    await expect(
      pluginVersionListHandler(
        { pluginId: "nope", limit: 20, includeChangelog: false },
        CTX,
      ),
    ).rejects.toThrow("Unknown plugin: nope");
  });

  it("returns the built-in current version with real cached history", async () => {
    setup({
      builtIn: {
        metadata: { version: "2.1.0", schemaVersion: "oxagen.ai/v1alpha1" },
      },
      history: [
        {
          pluginVersion: "2.1.0",
          schemaVersion: "oxagen.ai/v1alpha1",
          cachedAt: D2,
          schema: {},
        },
        {
          pluginVersion: "2.0.0",
          schemaVersion: "oxagen.ai/v1alpha1",
          cachedAt: D1,
          schema: {},
        },
      ],
      installed: true,
    });

    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: false },
      CTX,
    );

    expect(out.pluginId).toBe("github");
    expect(out.currentVersion).toBe("2.1.0");
    expect(out.installedVersion).toBe("2.1.0");
    expect(out.hasBreakingUpdate).toBe(false);
    expect(out.versions).toHaveLength(2);
    expect(out.versions[0]).toEqual({
      version: "2.1.0",
      releasedAt: D2.toISOString(),
      isBreaking: false,
      schemaVersion: "oxagen.ai/v1alpha1",
    });
  });

  it("reports installedVersion=null when the org has no connection of this plugin", async () => {
    setup({
      builtIn: { metadata: { version: "2.1.0", schemaVersion: "v1" } },
      history: [],
      installed: false,
    });
    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: false },
      CTX,
    );
    expect(out.installedVersion).toBeNull();
    // No cached schema versions yet → empty history, real currentVersion.
    expect(out.versions).toEqual([]);
    expect(out.currentVersion).toBe("2.1.0");
  });

  it("includes changelog only when requested and present in the cached schema", async () => {
    setup({
      builtIn: { metadata: { version: "2.1.0", schemaVersion: "v1" } },
      history: [
        {
          pluginVersion: "2.1.0",
          schemaVersion: "v1",
          cachedAt: D2,
          schema: { metadata: { changelog: "Added webhooks" } },
        },
      ],
      installed: false,
    });
    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: true },
      CTX,
    );
    expect(out.versions[0]).toMatchObject({ changelog: "Added webhooks" });
  });

  it("omits changelog when requested but absent from the cached schema", async () => {
    setup({
      builtIn: { metadata: { version: "2.1.0", schemaVersion: "v1" } },
      history: [
        {
          pluginVersion: "2.1.0",
          schemaVersion: "v1",
          cachedAt: D2,
          schema: {},
        },
      ],
      installed: false,
    });
    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: true },
      CTX,
    );
    expect(out.versions[0]).not.toHaveProperty("changelog");
  });

  it("surfaces minimumPlatformVersion from the cached schema metadata when present", async () => {
    setup({
      builtIn: { metadata: { version: "2.1.0", schemaVersion: "v1" } },
      history: [
        {
          pluginVersion: "2.1.0",
          schemaVersion: "v1",
          cachedAt: D2,
          schema: { metadata: { minimumPlatformVersion: "1.5.0" } },
        },
      ],
      installed: false,
    });
    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: false },
      CTX,
    );
    expect(out.versions[0]).toMatchObject({ minimumPlatformVersion: "1.5.0" });
  });

  it("falls back to the Oxagen plugin-registry manifest version for non-connector plugins", async () => {
    setup({
      builtIn: null,
      manifest: { version: "3.0.0" },
      history: [],
      installed: false,
    });
    const out = await pluginVersionListHandler(
      { pluginId: "oxagen/media-video", limit: 20, includeChangelog: false },
      CTX,
    );
    expect(out.currentVersion).toBe("3.0.0");
  });

  it("returns empty history (not a 500) when the connector_schemas read is denied", async () => {
    // connector_schemas is a shared catalog the oxagen_app role may lack grants on
    // in some envs; the denied read must degrade to empty history, not throw.
    mocks.loadBuiltInSchema.mockReturnValue({
      metadata: { version: "2.1.0", schemaVersion: "v1" },
    });
    mocks.getOxagenPlugin.mockReturnValue(undefined);
    mocks.withTenantDb
      .mockRejectedValueOnce(
        new Error("permission denied for table connector_schemas"),
      )
      .mockImplementationOnce((fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({ limit: () => Promise.resolve([]) }),
            }),
          }),
        }),
      );

    const out = await pluginVersionListHandler(
      { pluginId: "github", limit: 20, includeChangelog: false },
      CTX,
    );
    expect(out.currentVersion).toBe("2.1.0");
    expect(out.versions).toEqual([]);
    expect(out.installedVersion).toBeNull();
  });
});
