import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  loadBuiltInSchema: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/ingestion/connector-schema-loader", () => ({
  loadBuiltInSchema: mocks.loadBuiltInSchema,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pluginSchemaGetHandler } from "./plugin.schema.get";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

const BUILT_IN = {
  metadata: {
    id: "github",
    displayName: "GitHub",
    version: "1.0.0",
    schemaVersion: "1",
  },
  config: { fields: [{ key: "organizations", label: "Organizations" }] },
} as unknown as NonNullable<ReturnType<typeof mocks.loadBuiltInSchema>>;

/** Mock tx supporting both the cache write (insert chain) and read (select chain). */
function makeTx(opts: { selectRows?: unknown[]; onWrite?: () => void } = {}) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => {
          opts.onWrite?.();
          return Promise.resolve(undefined);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(opts.selectRows ?? []),
          }),
        }),
      }),
    }),
  };
}

describe("plugin.schema.get handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the bundled schema for a built-in connector (and warms the cache)", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(BUILT_IN);
    const onWrite = vi.fn();
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx({ onWrite })),
    );

    const out = await pluginSchemaGetHandler({ pluginId: "github" }, CTX);

    expect(out).toBe(BUILT_IN);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("BUG: still returns the built-in schema when the connector_schemas cache write THROWS (permission denied)", async () => {
    // Regression for the prod 500: the unguarded DB touch on the connector_schemas
    // system catalog (oxagen_app lacks grants in some envs) must NOT fail the
    // Configure form — built-ins resolve from the bundled YAML regardless.
    mocks.loadBuiltInSchema.mockReturnValue(BUILT_IN);
    mocks.withTenantDb.mockRejectedValue(
      new Error("permission denied for table connector_schemas"),
    );

    const out = await pluginSchemaGetHandler({ pluginId: "github" }, CTX);

    expect(out).toBe(BUILT_IN);
  });

  it("returns a partner plugin's schema from the DB cache when present", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    const cached = { metadata: { id: "acme" } };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTx({ selectRows: [{ schema: cached }] })),
    );

    const out = await pluginSchemaGetHandler({ pluginId: "acme" }, CTX);

    expect(out).toEqual(cached);
  });

  it("404s (not 500) for a partner plugin when the cache read THROWS", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    mocks.withTenantDb.mockRejectedValue(
      new Error("permission denied for table connector_schemas"),
    );

    await expect(
      pluginSchemaGetHandler({ pluginId: "acme" }, CTX),
    ).rejects.toThrow("Schema not found for plugin: acme");
  });

  it("404s for an unknown plugin with an empty cache", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx({ selectRows: [] })),
    );

    await expect(
      pluginSchemaGetHandler({ pluginId: "nope" }, CTX),
    ).rejects.toThrow("Schema not found for plugin: nope");
  });
});
