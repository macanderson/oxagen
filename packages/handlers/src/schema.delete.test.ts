import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
});

import { schemaDeleteHandler } from "./schema.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = { schemaName: "Person" };

/**
 * Build a mock tx that models the schema.delete query pattern:
 *
 * select 1: schema row  (uses .limit(1))
 * select 2: labels      (awaited from .where() directly — no .limit)
 * select 3: rels        (awaited from .where() directly — no .limit)
 *
 * update calls: schemaProperties for labels, schemaProperties for rels,
 *               nodeLabels, relationshipTypes, schemas
 */
function makeTx(opts: {
  schemaRow: object | null;
  labels: object[];
  rels: object[];
}) {
  let selectCallCount = 0;
  const updateWhere = vi.fn().mockResolvedValue(undefined);

  const tx = {
    select: (_projection?: unknown) => {
      selectCallCount++;
      const num = selectCallCount;
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => {
            if (num === 1) {
              // Schema row lookup — handler does .limit(1)
              return {
                limit: () =>
                  Promise.resolve(opts.schemaRow ? [opts.schemaRow] : []),
              };
            }
            if (num === 2) {
              // Labels — handler awaits .where() directly
              return Promise.resolve(opts.labels);
            }
            if (num === 3) {
              // Rels — handler awaits .where() directly
              return Promise.resolve(opts.rels);
            }
            return Promise.resolve([]);
          },
        }),
      };
    },
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: updateWhere,
      }),
    }),
  };

  return { tx, updateWhere };
}

describe("schemaDeleteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── early exit: no draftVersionId ────────────────────────────────────────

  it("returns deleted=false immediately when no draftVersionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);
    expect(result).toEqual({
      deleted: false,
      schemaName: "Person",
      labelsRemoved: 0,
      relationshipTypesRemoved: 0,
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  // ── schema not found ─────────────────────────────────────────────────────

  it("returns deleted=false when schema not found in draft", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx } = makeTx({ schemaRow: null, labels: [], rels: [] });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);
    expect(result.deleted).toBe(false);
    expect(result.labelsRemoved).toBe(0);
    expect(result.relationshipTypesRemoved).toBe(0);
  });

  // ── schema found, no labels or rels ─────────────────────────────────────

  it("soft-deletes schema with no labels or rels (1 update call for schema)", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx, updateWhere } = makeTx({
      schemaRow: { id: "schema_1" },
      labels: [],
      rels: [],
    });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);

    expect(result.deleted).toBe(true);
    expect(result.labelsRemoved).toBe(0);
    expect(result.relationshipTypesRemoved).toBe(0);
    expect(result.schemaName).toBe("Person");
    // Only the schema itself gets updated (no label/rel branches)
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  // ── schema found, with labels only ──────────────────────────────────────

  it("soft-deletes schema with labels but no rels", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx, updateWhere } = makeTx({
      schemaRow: { id: "schema_1" },
      labels: [{ id: "label_1" }, { id: "label_2" }],
      rels: [],
    });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);

    expect(result.deleted).toBe(true);
    expect(result.labelsRemoved).toBe(2);
    expect(result.relationshipTypesRemoved).toBe(0);
    // Updates: schemaProperties for labels, nodeLabels, schemas = 3
    expect(updateWhere).toHaveBeenCalledTimes(3);
  });

  // ── schema found, with rels only ─────────────────────────────────────────

  it("soft-deletes schema with rels but no labels", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx, updateWhere } = makeTx({
      schemaRow: { id: "schema_1" },
      labels: [],
      rels: [{ id: "rel_1" }],
    });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);

    expect(result.deleted).toBe(true);
    expect(result.labelsRemoved).toBe(0);
    expect(result.relationshipTypesRemoved).toBe(1);
    // Updates: schemaProperties for rels, relationshipTypes, schemas = 3
    expect(updateWhere).toHaveBeenCalledTimes(3);
  });

  // ── schema found, with both labels and rels ──────────────────────────────

  it("soft-deletes schema with labels and rels, returning correct counts", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx, updateWhere } = makeTx({
      schemaRow: { id: "schema_1" },
      labels: [{ id: "label_1" }, { id: "label_2" }, { id: "label_3" }],
      rels: [{ id: "rel_1" }, { id: "rel_2" }],
    });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(BASE_INPUT, CTX);

    expect(result.deleted).toBe(true);
    expect(result.labelsRemoved).toBe(3);
    expect(result.relationshipTypesRemoved).toBe(2);
    expect(result.schemaName).toBe("Person");
    // Updates: schemaProperties for labels, schemaProperties for rels, nodeLabels, relationshipTypes, schemas = 5
    expect(updateWhere).toHaveBeenCalledTimes(5);
  });

  // ── schema name is always returned from input ─────────────────────────────

  it("returns schema name from input in all result shapes", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });

    const result = await schemaDeleteHandler({ schemaName: "Commit" }, CTX);
    expect(result.schemaName).toBe("Commit");
  });

  it("returns schemaName correctly when schema is found and deleted", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: "draft_1",
    });

    const { tx } = makeTx({
      schemaRow: { id: "schema_1" },
      labels: [],
      rels: [],
    });
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await schemaDeleteHandler(
      { schemaName: "MyCustomSchema" },
      CTX,
    );
    expect(result.schemaName).toBe("MyCustomSchema");
    expect(result.deleted).toBe(true);
  });
});
