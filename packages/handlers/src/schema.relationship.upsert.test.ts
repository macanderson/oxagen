/**
 * schema.relationship.upsert handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb)
 *   - ./schema.versioning (getOrCreateRegistry, getOrCreateDraftSchema)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectExistingRel: vi.fn(),
  updateRel: vi.fn(),
  insertRel: vi.fn(),
  selectExistingProp: vi.fn(),
  updateProp: vi.fn(),
  insertProp: vi.fn(),
  getOrCreateRegistry: vi.fn(),
  getOrCreateDraftSchema: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  let selectCallCount = 0;
  let insertCallCount = 0;
  let updateCallCount = 0;

  const makeFakeTx = () => ({
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: unknown) => {
            selectCallCount++;
            if (selectCallCount === 1) return mocks.selectExistingRel();
            return mocks.selectExistingProp();
          },
        }),
      }),
    }),
    update: (_table: unknown) => {
      updateCallCount++;
      const call = updateCallCount;
      return {
        set: (_vals: unknown) => ({
          where: (_cond: unknown) => ({
            returning: call === 1 ? mocks.updateRel : mocks.updateProp,
          }),
        }),
      };
    },
    insert: (_table: unknown) => {
      insertCallCount++;
      const call = insertCallCount;
      return {
        values: (_vals: unknown) => ({
          returning: call === 1 ? mocks.insertRel : mocks.insertProp,
        }),
      };
    },
  });

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      selectCallCount = 0;
      insertCallCount = 0;
      updateCallCount = 0;
      return fn(makeFakeTx());
    },
  };
});

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
  getOrCreateDraftSchema: mocks.getOrCreateDraftSchema,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaRelationshipUpsertHandler } from "./schema.relationship.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = { draftVersionId: "ver-draft-1" };
const SCHEMA_ROW = { id: "schema-internal-1" };

const BASE_INPUT = {
  schemaName: "core",
  name: "PAID_BY",
  displayName: "Paid By",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaRelationshipUpsertHandler", () => {
  describe("no draft version", () => {
    it("throws when draftVersionId is null", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue({ draftVersionId: null });
      await expect(
        schemaRelationshipUpsertHandler(BASE_INPUT, CTX),
      ).rejects.toThrow("No draft version found for registry");
    });
  });

  describe("create path (relationship type does not exist)", () => {
    it("returns created=true and the new relationshipTypeId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([]);
      mocks.insertRel.mockResolvedValue([
        { publicId: "rel_new_1", id: "rel-internal-1" },
      ]);

      const result = await schemaRelationshipUpsertHandler(BASE_INPUT, CTX);
      expect(result.created).toBe(true);
      expect(result.relationshipTypeId).toBe("rel_new_1");
    });

    it("calls getOrCreateDraftSchema with the correct schemaName", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([]);
      mocks.insertRel.mockResolvedValue([
        { publicId: "rel_new_1", id: "rel-internal-1" },
      ]);

      await schemaRelationshipUpsertHandler(BASE_INPUT, CTX);
      expect(mocks.getOrCreateDraftSchema).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        REGISTRY.draftVersionId,
        BASE_INPUT.schemaName,
        CTX.userId,
        expect.anything(),
      );
    });

    it("throws when insert returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([]);
      mocks.insertRel.mockResolvedValue([]);

      await expect(
        schemaRelationshipUpsertHandler(BASE_INPUT, CTX),
      ).rejects.toThrow(
        `Failed to insert relationship type ${BASE_INPUT.name}`,
      );
    });
  });

  describe("update path (relationship type already exists)", () => {
    it("returns created=false with the existing relationshipTypeId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([
        {
          id: "rel-internal-1",
          publicId: "rel_existing",
          description: null,
          startLabel: null,
          endLabel: null,
          cardinality: null,
        },
      ]);
      mocks.updateRel.mockResolvedValue([{ publicId: "rel_existing" }]);

      const result = await schemaRelationshipUpsertHandler(BASE_INPUT, CTX);
      expect(result.created).toBe(false);
      expect(result.relationshipTypeId).toBe("rel_existing");
    });

    it("falls back to existing.publicId when update returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([
        {
          id: "rel-internal-1",
          publicId: "rel_fallback",
          description: null,
          startLabel: null,
          endLabel: null,
          cardinality: null,
        },
      ]);
      mocks.updateRel.mockResolvedValue([]);

      const result = await schemaRelationshipUpsertHandler(BASE_INPUT, CTX);
      expect(result.relationshipTypeId).toBe("rel_fallback");
    });
  });

  describe("with inline properties", () => {
    it("does not throw when properties are provided and upserted (new prop)", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingRel.mockResolvedValue([]);
      mocks.insertRel.mockResolvedValue([
        { publicId: "rel_new_1", id: "rel-internal-1" },
      ]);
      mocks.selectExistingProp.mockResolvedValue([]);
      mocks.insertProp.mockResolvedValue([{ publicId: "prop_1" }]);

      const result = await schemaRelationshipUpsertHandler(
        {
          ...BASE_INPUT,
          properties: [
            { key: "since", dataType: "string" as const, required: false },
          ],
        },
        CTX,
      );
      expect(result.created).toBe(true);
    });
  });
});
