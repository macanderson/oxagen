import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDbFn: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDbFn,
  };
});

vi.mock("@oxagen/ingestion/validate", () => ({
  // Just need the types; no runtime value needed.
}));

// ─── import after mocks ───────────────────────────────────────────────────────
import {
  getPinnedSchema,
  invalidatePinnedSchemaCache,
  _clearPinnedSchemaCacheForTest,
} from "./schema.pinned";

// ─── helpers ──────────────────────────────────────────────────────────────────

const ORG_ID = "org_1";
const WS_ID = "ws_1";

/**
 * Build the mock tx whose select() calls are intercepted in order.
 *
 * Drizzle query chains terminate at different points:
 *  - `.select().from().where()` → Promise (no .limit())
 *  - `.select().from().where().limit()` → Promise
 *  - `.select().from().where().limit().offset()` → Promise (for version list)
 *  - `.select().from().where(...).from(...)...` with inArray variants
 *
 * The chain object is made thenable (`.then`) so it works as a Promise when
 * awaited directly (e.g. `await tx.select().from().where()`), AND `.limit()`
 * and `.offset()` also return Promises so that:
 *   `await tx.select().from().where().limit(1)` also resolves.
 */
function buildTx(selectResults: unknown[][]): Record<string, unknown> {
  let callIndex = 0;
  const tx = {
    select: vi.fn(() => {
      const result = selectResults[callIndex] ?? [];
      callIndex++;
      // Make the chain itself a thenable so `await chain` works. The `then`
      // signature mirrors PromiseLike so the object typechecks as PromiseLike.
      const chain: Record<string, unknown> & PromiseLike<unknown> = {
        then: <T1 = unknown, T2 = never>(
          onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): PromiseLike<T1 | T2> =>
          Promise.resolve(result).then(onfulfilled, onrejected),
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(result)),
        offset: vi.fn(() => Promise.resolve(result)),
      };
      return chain;
    }),
  };
  return tx;
}

/** Install a withTenantDb implementation that drives `tx` through `fn`. */
function installTx(tx: Record<string, unknown>) {
  mocks.withTenantDbFn.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
}

// ── Registry row helpers ──────────────────────────────────────────────────────

const REG_ROW = {
  registryId: "reg-internal-id",
  pinnedVersionId: "ver-internal-id",
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

const VERSION_ROW = { versionNumber: 3 };

const SCHEMA_ROW = {
  id: "schema-id-1",
  name: "core",
  source: "user",
};

const LABEL_ROW = {
  id: "label-id-1",
  schemaId: "schema-id-1",
  name: "Person",
  displayName: "Person",
  description: "A human",
  naturalKeyProps: ["name"],
};

const REL_ROW = {
  id: "rel-id-1",
  schemaId: "schema-id-1",
  name: "KNOWS",
  displayName: "Knows",
  description: null,
  startLabel: "Person",
  endLabel: "Person",
  cardinality: "MANY_TO_MANY",
};

const PROP_ROW = {
  nodeLabelId: "label-id-1",
  relationshipTypeId: null,
  key: "name",
  dataType: "string",
  required: true,
  description: "Full name",
  enumValues: null,
  itemType: null,
  constraints: { minLength: 1 },
  example: "Alice",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("getPinnedSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearPinnedSchemaCacheForTest();
  });

  // ── null paths ────────────────────────────────────────────────────────────

  it("returns null when registry row is not found", async () => {
    const tx = buildTx([
      [], // registry query → no row
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result).toBeNull();
  });

  it("returns null when registry exists but pinnedVersionId is null", async () => {
    const tx = buildTx([[{ ...REG_ROW, pinnedVersionId: null }]]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result).toBeNull();
  });

  // ── empty vocabulary paths ─────────────────────────────────────────────────

  it("returns empty vocabulary when pinned version has no schemas", async () => {
    const tx = buildTx([
      [REG_ROW], // registry
      [VERSION_ROW], // version row
      [], // schemas → empty
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result).not.toBeNull();
    expect(result!.labels).toHaveLength(0);
    expect(result!.relationshipTypes).toHaveLength(0);
    expect(result!.versionId).toBe("ver-internal-id");
    expect(result!.versionNumber).toBe(3);
    expect(result!.enforcementMode).toBe("lenient");
    expect(result!.conformanceFloor).toBe(0.5);
  });

  it("returns empty vocabulary when all schemas are disabled", async () => {
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW], // schemas
      [{ schemaName: "core", enabled: false }], // activations (disabled)
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result).not.toBeNull();
    expect(result!.labels).toHaveLength(0);
    expect(result!.relationshipTypes).toHaveLength(0);
  });

  // ── happy path (cache miss) ────────────────────────────────────────────────

  it("resolves active vocabulary on cache miss with full label + rel + prop data", async () => {
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [], // activations → no row → defaults to enabled
      [LABEL_ROW], // labels
      [REL_ROW], // rels
      [PROP_ROW], // props
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result).not.toBeNull();
    expect(result!.labels).toHaveLength(1);
    const [label] = result!.labels;
    expect(label!.name).toBe("Person");
    expect(label!.schemaName).toBe("core");
    expect(label!.properties).toHaveLength(1);
    const [labelProp] = label!.properties;
    expect(labelProp!.key).toBe("name");
    expect(labelProp!.dataType).toBe("string");
    expect(labelProp!.required).toBe(true);
    expect(labelProp!.constraints).toEqual({
      min: undefined,
      max: undefined,
      minLength: 1,
      maxLength: undefined,
      pattern: undefined,
    });

    expect(result!.relationshipTypes).toHaveLength(1);
    const [rel] = result!.relationshipTypes;
    expect(rel!.name).toBe("KNOWS");
    expect(rel!.cardinality).toBe("MANY_TO_MANY");
  });

  it("schema with no activation row defaults to enabled (§4.8)", async () => {
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [], // activations → empty → enabled by default
      [LABEL_ROW],
      [REL_ROW],
      [], // props
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result!.labels).toHaveLength(1);
    expect(result!.relationshipTypes).toHaveLength(1);
  });

  // ── cache hit ─────────────────────────────────────────────────────────────

  it("returns cached value on second call without hitting DB again", async () => {
    // First call – full data
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [], // activations
      [LABEL_ROW],
      [REL_ROW],
      [PROP_ROW],
    ]);
    installTx(tx);

    const first = await getPinnedSchema(ORG_ID, WS_ID);
    expect(first).not.toBeNull();

    // Second call – withTenantDb still invoked (cache check happens inside fn),
    // but the early-return skips the heavy queries.
    // Reset tx to only return registry/version/schema/activation (4 selects)
    // so that if the cache is used properly only those initial selects fire.
    const tx2 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [], // activations
      // NO label/rel/prop selects — cache hit avoids them
    ]);
    installTx(tx2);

    const second = await getPinnedSchema(ORG_ID, WS_ID);
    expect(second).not.toBeNull();
    expect(second!.labels).toHaveLength(1);
    expect(second!.relationshipTypes).toHaveLength(1);
  });

  it("bypasses cache when fingerprint changes (schema enabled set changed)", async () => {
    // First call: schema 'core' enabled
    const tx1 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [], // no activation → enabled
      [LABEL_ROW],
      [REL_ROW],
      [],
    ]);
    installTx(tx1);
    const first = await getPinnedSchema(ORG_ID, WS_ID);
    expect(first!.labels).toHaveLength(1);

    // Second call: schema 'core' is now disabled → different fingerprint
    const tx2 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [{ schemaName: "core", enabled: false }], // disabled!
    ]);
    installTx(tx2);
    const second = await getPinnedSchema(ORG_ID, WS_ID);
    expect(second!.labels).toHaveLength(0);
  });

  it("bypasses cache when versionId changes (new pin)", async () => {
    // First call: version A
    const tx1 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [],
      [LABEL_ROW],
      [REL_ROW],
      [],
    ]);
    installTx(tx1);
    const first = await getPinnedSchema(ORG_ID, WS_ID);
    expect(first!.versionId).toBe("ver-internal-id");

    // Second call: different pinnedVersionId
    const newReg = { ...REG_ROW, pinnedVersionId: "ver-internal-id-V2" };
    const tx2 = buildTx([
      [newReg],
      [{ versionNumber: 4 }],
      [], // no schemas → empty vocabulary
    ]);
    installTx(tx2);
    const second = await getPinnedSchema(ORG_ID, WS_ID);
    expect(second!.versionId).toBe("ver-internal-id-V2");
    expect(second!.versionNumber).toBe(4);
  });

  // ── property edge cases ───────────────────────────────────────────────────

  it("groups rel properties correctly (property has relationshipTypeId, not nodeLabelId)", async () => {
    const relPropRow = {
      nodeLabelId: null,
      relationshipTypeId: "rel-id-1",
      key: "since",
      dataType: "date",
      required: false,
      description: null,
      enumValues: null,
      itemType: null,
      constraints: {},
      example: null,
    };
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [],
      [], // no labels → labelIds empty
      [REL_ROW],
      [relPropRow],
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result!.labels).toHaveLength(0);
    const [rel] = result!.relationshipTypes;
    expect(rel!.properties).toHaveLength(1);
    expect(rel!.properties[0]!.key).toBe("since");
  });

  it("skips property rows where both nodeLabelId and relationshipTypeId are null", async () => {
    const orphanProp = {
      nodeLabelId: null,
      relationshipTypeId: null,
      key: "orphan",
      dataType: "string",
      required: false,
      description: null,
      enumValues: null,
      itemType: null,
      constraints: {},
      example: null,
    };
    const tx = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [],
      [LABEL_ROW],
      [REL_ROW],
      [orphanProp],
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    // Orphaned property should not be included in either labels or rels
    expect(result!.labels[0]!.properties).toHaveLength(0);
    expect(result!.relationshipTypes[0]!.properties).toHaveLength(0);
  });

  it("defaults versionNumber to 0 when version row is missing", async () => {
    const tx = buildTx([
      [REG_ROW],
      [], // version row → empty
      [], // schemas → empty (triggers emptyVocabulary)
    ]);
    installTx(tx);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result!.versionNumber).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("invalidatePinnedSchemaCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearPinnedSchemaCacheForTest();
  });

  it("invalidates cache so next call re-fetches from DB", async () => {
    // Warm the cache
    const tx1 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [],
      [LABEL_ROW],
      [REL_ROW],
      [],
    ]);
    installTx(tx1);
    await getPinnedSchema(ORG_ID, WS_ID);

    // Invalidate
    invalidatePinnedSchemaCache(WS_ID);

    // Next call: different version → should see new data (not cached)
    const newReg = { ...REG_ROW, pinnedVersionId: "ver-after-invalidate" };
    const tx2 = buildTx([[newReg], [{ versionNumber: 99 }], []]);
    installTx(tx2);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result!.versionId).toBe("ver-after-invalidate");
    expect(result!.versionNumber).toBe(99);
  });

  it("is a no-op for a workspaceId not in the cache", () => {
    // Should not throw
    expect(() => invalidatePinnedSchemaCache("non-existent-ws")).not.toThrow();
  });
});

describe("_clearPinnedSchemaCacheForTest", () => {
  it("clears all cached entries", async () => {
    const tx1 = buildTx([
      [REG_ROW],
      [VERSION_ROW],
      [SCHEMA_ROW],
      [],
      [LABEL_ROW],
      [REL_ROW],
      [],
    ]);
    installTx(tx1);
    await getPinnedSchema(ORG_ID, WS_ID);

    // Clear
    _clearPinnedSchemaCacheForTest();

    // Cache is empty → re-fetches and sees new version
    const newReg = { ...REG_ROW, pinnedVersionId: "after-clear" };
    const tx2 = buildTx([[newReg], [{ versionNumber: 77 }], []]);
    installTx(tx2);

    const result = await getPinnedSchema(ORG_ID, WS_ID);
    expect(result!.versionId).toBe("after-clear");
  });
});
