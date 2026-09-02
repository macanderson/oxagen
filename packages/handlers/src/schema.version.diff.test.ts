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

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaVersionDiffHandler } from "./schema.version.diff";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an ordered-select tx. Each call to `select()` returns the next result.
 * The diff handler terminates queries at `.where()` (no .limit()) via Promise.all,
 * so the chain must be thenable.
 */
function buildSelectTx(results: unknown[][]): Record<string, unknown> {
  let idx = 0;
  const tx = {
    select: vi.fn(() => {
      const result = results[idx++] ?? [];
      const chain: Record<string, unknown> & PromiseLike<unknown> = {
        then: <T1 = unknown, T2 = never>(
          onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): PromiseLike<T1 | T2> =>
          Promise.resolve(result).then(onfulfilled, onrejected),
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(result)),
      };
      return chain;
    }),
  };
  return tx;
}

function installTx(results: unknown[][]) {
  mocks.withTenantDbFn.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(buildSelectTx(results)),
  );
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const FROM_PUB_ID = "scv_from";
const TO_PUB_ID = "scv_to";

const FROM_VER = {
  id: "from-internal",
  publicId: FROM_PUB_ID,
  registryId: "r1",
};
const TO_VER = { id: "to-internal", publicId: TO_PUB_ID, registryId: "r1" };

const INPUT = { fromVersionId: FROM_PUB_ID, toVersionId: TO_PUB_ID };

/** Schema rows */
function schema(id: string, name: string, versionId: string) {
  return { id, name, displayName: name, versionId };
}

/** Label rows */
function label(
  id: string,
  schemaId: string,
  name: string,
  opts: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    schemaId,
    name,
    displayName: name,
    description: null,
    naturalKeyProps: [],
    ...opts,
  };
}

/** Rel rows */
function rel(
  id: string,
  schemaId: string,
  name: string,
  opts: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    schemaId,
    name,
    displayName: name,
    startLabel: null,
    endLabel: null,
    cardinality: null,
    ...opts,
  };
}

/** Property rows */
function prop(
  nodeLabelId: string | null,
  relTypeId: string | null,
  key: string,
  dataType = "string",
) {
  return {
    id: `prop-${key}`,
    nodeLabelId,
    relationshipTypeId: relTypeId,
    key,
    dataType,
    required: false,
    description: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("schemaVersionDiffHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("throws when fromVersion is not found", async () => {
    installTx([
      [TO_VER], // only to version returned, from is missing
    ]);

    await expect(schemaVersionDiffHandler(INPUT, CTX)).rejects.toThrow(
      `Version ${FROM_PUB_ID} not found`,
    );
  });

  it("throws when toVersion is not found", async () => {
    installTx([
      [FROM_VER], // only from returned, to is missing
    ]);

    await expect(schemaVersionDiffHandler(INPUT, CTX)).rejects.toThrow(
      `Version ${TO_PUB_ID} not found`,
    );
  });

  // ── empty diff (identical versions) ──────────────────────────────────────

  it("returns all-empty diffs when versions are identical", async () => {
    const s = schema("s1", "core", "from-internal");
    installTx([
      [FROM_VER, TO_VER], // version rows
      [s], // fromSchemas
      [s], // toSchemas
      [], // fromLabels
      [], // toLabels
      [], // fromRels
      [], // toRels
      [], // fromProps
      [], // toProps
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);

    expect(result.schemasAdded).toHaveLength(0);
    expect(result.schemasRemoved).toHaveLength(0);
    expect(result.labelsAdded).toHaveLength(0);
    expect(result.labelsRemoved).toHaveLength(0);
    expect(result.labelsChanged).toHaveLength(0);
    expect(result.relationshipTypesAdded).toHaveLength(0);
    expect(result.relationshipTypesRemoved).toHaveLength(0);
    expect(result.relationshipTypesChanged).toHaveLength(0);
    expect(result.propertiesAdded).toHaveLength(0);
    expect(result.propertiesRemoved).toHaveLength(0);
    expect(result.propertiesChanged).toHaveLength(0);
  });

  // ── schema added/removed ──────────────────────────────────────────────────

  it("detects added schemas (in to, not in from)", async () => {
    installTx([
      [FROM_VER, TO_VER],
      [], // fromSchemas
      [schema("s2", "new_schema", "to-int")], // toSchemas
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.schemasAdded).toContain("new_schema");
    expect(result.schemasRemoved).toHaveLength(0);
  });

  it("detects removed schemas (in from, not in to)", async () => {
    installTx([
      [FROM_VER, TO_VER],
      [schema("s1", "old_schema", "from-int")],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.schemasRemoved).toContain("old_schema");
    expect(result.schemasAdded).toHaveLength(0);
  });

  // ── label added/removed/changed ───────────────────────────────────────────

  it("detects added labels", async () => {
    const s = schema("s1", "core", "from-internal");
    installTx([
      [FROM_VER, TO_VER],
      [s], // fromSchemas
      [s], // toSchemas
      [], // fromLabels
      [label("l1", "s1", "Person")], // toLabels
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.labelsAdded).toHaveLength(1);
    expect(result.labelsAdded[0]).toEqual({
      schemaName: "core",
      labelName: "Person",
    });
  });

  it("detects removed labels", async () => {
    const s = schema("s1", "core", "from-internal");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [label("l1", "s1", "Person")],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.labelsRemoved).toHaveLength(1);
    expect(result.labelsRemoved[0]).toEqual({
      schemaName: "core",
      labelName: "Person",
    });
  });

  it("detects changed labels (displayName change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const fromLabel = label("l1", "s1", "Person", { displayName: "Person v1" });
    const toLabel = label("l2", "s1", "Person", { displayName: "Person v2" });
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [fromLabel],
      [toLabel],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.labelsChanged).toHaveLength(1);
    expect(result.labelsChanged[0]!.changes).toContain("displayName");
  });

  it("detects changed labels (naturalKeyProps change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const fromLabel = label("l1", "s1", "Person", { naturalKeyProps: [] });
    const toLabel = label("l2", "s1", "Person", { naturalKeyProps: ["email"] });
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [fromLabel],
      [toLabel],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.labelsChanged[0]!.changes).toContain("naturalKeyProps");
  });

  it("detects changed labels (description change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const fromLabel = label("l1", "s1", "Person", { description: null });
    const toLabel = label("l2", "s1", "Person", { description: "Updated" });
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [fromLabel],
      [toLabel],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.labelsChanged[0]!.changes).toContain("description");
  });

  // ── relationship type diffs ───────────────────────────────────────────────

  it("detects added relationship types", async () => {
    const s = schema("s1", "core", "from-internal");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [],
      [],
      [], // fromRels
      [rel("r1", "s1", "KNOWS")], // toRels
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.relationshipTypesAdded).toHaveLength(1);
    expect(result.relationshipTypesAdded[0]).toEqual({
      schemaName: "core",
      relationshipTypeName: "KNOWS",
    });
  });

  it("detects removed relationship types", async () => {
    const s = schema("s1", "core", "from-internal");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [],
      [],
      [rel("r1", "s1", "KNOWS")],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.relationshipTypesRemoved).toHaveLength(1);
    expect(result.relationshipTypesRemoved[0]!.relationshipTypeName).toBe(
      "KNOWS",
    );
  });

  it("detects changed relationship types (startLabel change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const fromRel = rel("r1", "s1", "KNOWS", { startLabel: "Person" });
    const toRel = rel("r2", "s1", "KNOWS", { startLabel: "Organization" });
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [],
      [],
      [fromRel],
      [toRel],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.relationshipTypesChanged[0]!.changes).toContain("startLabel");
  });

  // ── property diffs ────────────────────────────────────────────────────────

  it("detects added properties", async () => {
    const s = schema("s1", "core", "from-internal");
    const l1 = label("l1", "s1", "Person");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [l1],
      [l1],
      [],
      [],
      [], // fromProps
      [prop("l1", null, "email")], // toProps
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.propertiesAdded).toHaveLength(1);
    expect(result.propertiesAdded[0]).toEqual({
      ownerName: "Person",
      key: "email",
    });
  });

  it("detects removed properties", async () => {
    const s = schema("s1", "core", "from-internal");
    const l1 = label("l1", "s1", "Person");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [l1],
      [l1],
      [],
      [],
      [prop("l1", null, "email")],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.propertiesRemoved).toHaveLength(1);
    expect(result.propertiesRemoved[0]).toEqual({
      ownerName: "Person",
      key: "email",
    });
  });

  it("detects changed properties (dataType change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const l1 = label("l1", "s1", "Person");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [l1],
      [l1],
      [],
      [],
      [prop("l1", null, "age", "string")],
      [prop("l1", null, "age", "integer")],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.propertiesChanged).toHaveLength(1);
    expect(result.propertiesChanged[0]!.changes).toContain("dataType");
  });

  it("detects changed properties (required change)", async () => {
    const s = schema("s1", "core", "from-internal");
    const l1 = label("l1", "s1", "Person");
    const fromProp = { ...prop("l1", null, "name"), required: false };
    const toProp = { ...prop("l1", null, "name"), required: true };
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [l1],
      [l1],
      [],
      [],
      [fromProp],
      [toProp],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.propertiesChanged[0]!.changes).toContain("required");
  });

  it("handles property owned by a relationship type", async () => {
    const s = schema("s1", "core", "from-internal");
    const r1 = rel("r1", "s1", "KNOWS");
    installTx([
      [FROM_VER, TO_VER],
      [s],
      [s],
      [],
      [],
      [r1],
      [r1],
      [],
      [prop(null, "r1", "since")],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.propertiesAdded[0]).toEqual({
      ownerName: "KNOWS",
      key: "since",
    });
  });

  // ── no schemas edge case ──────────────────────────────────────────────────

  it("returns all-empty diff when both versions have no schemas", async () => {
    installTx([
      [FROM_VER, TO_VER],
      [], // fromSchemas
      [], // toSchemas
      // Promise.all branches should resolve to [] when allSchemaIds is empty
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await schemaVersionDiffHandler(INPUT, CTX);
    expect(result.schemasAdded).toHaveLength(0);
    expect(result.schemasRemoved).toHaveLength(0);
    expect(result.labelsAdded).toHaveLength(0);
    expect(result.propertiesAdded).toHaveLength(0);
  });
});
