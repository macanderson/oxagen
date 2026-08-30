import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
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

import { schemaExportHandler } from "./schema.export";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

type ArchiveEntry = { name: string; text: string };

const MOCK_ARCHIVE_RESULT = {
  assetId: "asset_abc",
  serveUrl: "https://blob.example.com/schema-export-v2.zip",
  publicId: "arc_xyz",
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

/** Read the `entries` array from the first archive.create invoke call (strict-safe). */
function firstInvokeEntries(): ArchiveEntry[] {
  const calls = mocks.invoke.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const firstCall = calls[0];
  expect(firstCall).toBeDefined();
  const payload = firstCall![1] as { entries: ArchiveEntry[] };
  return payload.entries;
}

describe("schemaExportHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(MOCK_ARCHIVE_RESULT);
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
    expect(result.serveUrl).toBe(MOCK_ARCHIVE_RESULT.serveUrl);
    expect(result.versionId).toBe("scv_pub_1");
    expect(result.versionNumber).toBe(2);

    // archive.create should have been invoked
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_archive",
      expect.objectContaining({
        archiveName: "schema-export-v2",
        entries: expect.arrayContaining([
          expect.objectContaining({ name: "manifest.json" }),
        ]),
      }),
      CTX,
      { surface: "api" },
    );
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
