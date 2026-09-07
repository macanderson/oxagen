import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  persistGeneratedAsset: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
}));

// ADR-043 removed `create_archive`; schema.export now builds the ZIP itself and
// writes it through the shared asset chokepoint, so that is the seam to stub.
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: (...args: unknown[]) =>
    mocks.persistGeneratedAsset(...args),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(),
  };
});

import { unzipSync, strFromU8 } from "fflate";
import { schemaExportHandler } from "./schema.export";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

type ArchiveEntry = { name: string; text: string };

const MOCK_PERSISTED_ASSET = {
  id: "asset_abc",
  publicId: "gen_xyz",
  kind: "archive" as const,
  mimeType: "application/zip",
  sizeBytes: 512,
  key: "generated/archives/org_1/x.zip",
  url: "https://blob.example.com/x.zip",
  serveUrl: "/api/v1/assets/gen_xyz",
};

const MOCK_VERSION_ROW = {
  id: "ver_internal_1",
  publicId: "scv_pub_1",
  versionNumber: 2,
};

function makeExportTx(opts: {
  versionRow?: object | null;
  schemas?: object[];
  labels?: object[];
  rels?: object[];
  props?: object[];
}) {
  const {
    versionRow = MOCK_VERSION_ROW,
    schemas = [],
    labels = [],
    rels = [],
    props = [],
  } = opts;

  let selectCallCount = 0;

  return {
    select: () => {
      selectCallCount++;
      const num = selectCallCount;
      return {
        from: () => ({
          where: () => {
            if (num === 1) {
              // schemaVersions lookup
              return {
                limit: () => Promise.resolve(versionRow ? [versionRow] : []),
              };
            }
            if (num === 2) {
              // schemas select
              return Promise.resolve(schemas);
            }
            if (num === 3) {
              // nodeLabels select
              return Promise.resolve(labels);
            }
            if (num === 4) {
              // relationshipTypes select
              return Promise.resolve(rels);
            }
            if (num === 5) {
              // schemaProperties select
              return Promise.resolve(props);
            }
            return Promise.resolve([]);
          },
        }),
      };
    },
  };
}

/**
 * Recover the archive entries by UNZIPPING the bytes the handler persisted.
 * Stronger than reading an intermediate array: it proves the ZIP the caller
 * actually downloads carries the §15 layout.
 */
function firstInvokeEntries(): ArchiveEntry[] {
  const calls = mocks.persistGeneratedAsset.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  expect(firstCall).toBeDefined();
  const { bytes } = firstCall![0] as { bytes: Uint8Array };
  const unzipped = unzipSync(bytes);
  return Object.entries(unzipped).map(([name, data]) => ({
    name,
    text: strFromU8(data),
  }));
}

describe("schemaExportHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistGeneratedAsset.mockResolvedValue(MOCK_PERSISTED_ASSET);
  });

  // ── throws when no version available ─────────────────────────────────────

  it("throws when registry has no pinned or draft version and no explicit versionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    await expect(schemaExportHandler({}, CTX)).rejects.toThrow(
      "No version available to export",
    );
  });

  // ── uses explicit versionId when provided ─────────────────────────────────

  it("uses explicit versionId over registry defaults", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal",
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      return fn(makeExportTx({}) as unknown as Parameters<typeof fn>[0]);
    });

    const result = await schemaExportHandler(
      { versionId: "scv_explicit" },
      CTX,
    );

    expect(result.versionId).toBe("scv_explicit");
  });

  // ── uses pinned version when no explicit versionId ────────────────────────

  it("resolves pinned version public id and uses it", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_id",
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    // First call = resolvePublicId for pinnedVersionId
    // Second call = main export withTenantDb
    vi.mocked(withTenantDb)
      .mockImplementationOnce(async (fn) => {
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ publicId: "scv_pinned_pub" }]),
              }),
            }),
          }),
        };
        return fn(tx as unknown as Parameters<typeof fn>[0]);
      })
      .mockImplementationOnce(async (fn) => {
        return fn(makeExportTx({}) as unknown as Parameters<typeof fn>[0]);
      });

    const result = await schemaExportHandler({}, CTX);
    expect(result.versionId).toBe("scv_pinned_pub");
  });

  // ── uses draft version when no pinned ────────────────────────────────────

  it("falls back to draft when no pinned version", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_internal_id",
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb)
      .mockImplementationOnce(async (fn) => {
        // resolvePublicId for draft
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ publicId: "scv_draft_pub" }]),
              }),
            }),
          }),
        };
        return fn(tx as unknown as Parameters<typeof fn>[0]);
      })
      .mockImplementationOnce(async (fn) => {
        return fn(makeExportTx({}) as unknown as Parameters<typeof fn>[0]);
      });

    const result = await schemaExportHandler({}, CTX);
    expect(result.versionId).toBe("scv_draft_pub");
  });

  // ── throws when version row not found in DB ───────────────────────────────

  it("throws when the resolved version is not found in DB", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      return fn(
        makeExportTx({ versionRow: null }) as unknown as Parameters<
          typeof fn
        >[0],
      );
    });

    await expect(
      schemaExportHandler({ versionId: "scv_nonexistent" }, CTX),
    ).rejects.toThrow("Version scv_nonexistent not found");
  });

  // ── happy path with schemas, labels, rels, props ─────────────────────────

  it("builds manifest.json entry and returns archive result", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      return fn(
        makeExportTx({
          versionRow: MOCK_VERSION_ROW,
          schemas: [],
          labels: [],
          rels: [],
          props: [],
        }) as unknown as Parameters<typeof fn>[0],
      );
    });

    const result = await schemaExportHandler({ versionId: "scv_pub_1" }, CTX);

    expect(result.assetId).toBe("asset_abc");
    expect(result.serveUrl).toBe(MOCK_PERSISTED_ASSET.serveUrl);
    expect(result.versionId).toBe("scv_pub_1");
    expect(result.versionNumber).toBe(2);

    // A workspace-visible zip asset, named for the version, was persisted.
    expect(mocks.persistGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        userId: CTX.userId,
        kind: "archive",
        mimeType: "application/zip",
        accessPolicy: "org",
        displayName: "schema-export-v2",
      }),
    );
    // …and its bytes are a real ZIP carrying the manifest.
    expect(firstInvokeEntries().map((e) => e.name)).toContain("manifest.json");
  });

  it("throws before persisting for an API-key-only principal", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });
    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      return fn(
        makeExportTx({
          versionRow: MOCK_VERSION_ROW,
        }) as unknown as Parameters<typeof fn>[0],
      );
    });

    await expect(
      schemaExportHandler({ versionId: "scv_pub_1" }, { ...CTX, userId: null }),
    ).rejects.toThrow(/requires an authenticated user/);
    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("generates per-schema label and relationship entries", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      let callCount = 0;
      const tx = {
        select: () => {
          callCount++;
          const n = callCount;
          return {
            from: () => ({
              where: () => {
                if (n === 1)
                  return { limit: () => Promise.resolve([MOCK_VERSION_ROW]) };
                if (n === 2)
                  return Promise.resolve([
                    { id: "schema_1", name: "Person", displayName: "Person" },
                  ]);
                if (n === 3)
                  return Promise.resolve([
                    {
                      id: "label_1",
                      schemaId: "schema_1",
                      name: "Human",
                      displayName: "Human",
                      description: "A human",
                      naturalKeyProps: ["email"],
                    },
                  ]);
                if (n === 4)
                  return Promise.resolve([
                    {
                      id: "rel_1",
                      schemaId: "schema_1",
                      name: "KNOWS",
                      displayName: "Knows",
                      description: null,
                      startLabel: "Human",
                      endLabel: "Human",
                      cardinality: "many-to-many",
                    },
                  ]);
                if (n === 5)
                  return Promise.resolve([
                    {
                      id: "prop_1",
                      nodeLabelId: "label_1",
                      relationshipTypeId: null,
                      key: "email",
                      dataType: "string",
                      required: true,
                      description: null,
                      enumValues: null,
                      itemType: null,
                      example: null,
                    },
                  ]);
                return Promise.resolve([]);
              },
            }),
          };
        },
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    await schemaExportHandler({ versionId: "scv_pub_1" }, CTX);

    const entries = firstInvokeEntries();
    const entryNames = entries.map((e) => e.name);
    expect(entryNames).toContain("manifest.json");
    expect(entryNames).toContain("schemas/Person/labels/Human.json");
    expect(entryNames).toContain("schemas/Person/relationships/KNOWS.json");
  });

  it("manifest.json contains correct schema names and version info", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      let callCount = 0;
      const tx = {
        select: () => {
          callCount++;
          const n = callCount;
          return {
            from: () => ({
              where: () => {
                if (n === 1)
                  return { limit: () => Promise.resolve([MOCK_VERSION_ROW]) };
                if (n === 2)
                  return Promise.resolve([
                    { id: "s1", name: "Person", displayName: "Person" },
                    { id: "s2", name: "Company", displayName: "Company" },
                  ]);
                // labels, rels, props all empty
                return Promise.resolve([]);
              },
            }),
          };
        },
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    await schemaExportHandler({ versionId: "scv_pub_1" }, CTX);

    const entries = firstInvokeEntries();
    const manifestEntry = entries.find((e) => e.name === "manifest.json");
    expect(manifestEntry).toBeDefined();

    const manifest = JSON.parse(manifestEntry!.text) as {
      version: string;
      versionNumber: number;
      schemas: string[];
      exportedAt: string;
    };
    expect(manifest.version).toBe("scv_pub_1");
    expect(manifest.versionNumber).toBe(2);
    expect(manifest.schemas).toEqual(["Person", "Company"]);
    expect(manifest.exportedAt).toBeDefined();
  });

  it("relationship entry includes properties for that relationship type", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(async (fn) => {
      let callCount = 0;
      const tx = {
        select: () => {
          callCount++;
          const n = callCount;
          return {
            from: () => ({
              where: () => {
                if (n === 1)
                  return { limit: () => Promise.resolve([MOCK_VERSION_ROW]) };
                if (n === 2)
                  return Promise.resolve([
                    { id: "schema_1", name: "Core", displayName: "Core" },
                  ]);
                if (n === 3) return Promise.resolve([]); // no labels
                if (n === 4)
                  return Promise.resolve([
                    {
                      id: "rel_1",
                      schemaId: "schema_1",
                      name: "RELATES_TO",
                      displayName: "Relates To",
                      description: "A relationship",
                      startLabel: "A",
                      endLabel: "B",
                      cardinality: "one-to-many",
                    },
                  ]);
                if (n === 5)
                  return Promise.resolve([
                    {
                      id: "p1",
                      nodeLabelId: null,
                      relationshipTypeId: "rel_1",
                      key: "weight",
                      dataType: "float",
                      required: false,
                      description: "edge weight",
                    },
                  ]);
                return Promise.resolve([]);
              },
            }),
          };
        },
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    await schemaExportHandler({ versionId: "scv_pub_1" }, CTX);

    const entries = firstInvokeEntries();
    const relEntry = entries.find(
      (e) => e.name === "schemas/Core/relationships/RELATES_TO.json",
    );
    expect(relEntry).toBeDefined();

    const relDoc = JSON.parse(relEntry!.text) as {
      name: string;
      startLabel: string;
      endLabel: string;
      cardinality: string;
      properties: Array<{ key: string }>;
    };
    expect(relDoc.name).toBe("RELATES_TO");
    expect(relDoc.startLabel).toBe("A");
    expect(relDoc.endLabel).toBe("B");
    expect(relDoc.cardinality).toBe("one-to-many");
    expect(relDoc.properties).toHaveLength(1);
    const [firstProp] = relDoc.properties;
    expect(firstProp?.key).toBe("weight");
  });
});
