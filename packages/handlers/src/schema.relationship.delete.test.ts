/**
 * schema.relationship.delete handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb)
 *   - ./schema.versioning (getOrCreateRegistry)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectSchema: vi.fn(),
  selectRel: vi.fn(),
  getOrCreateRegistry: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  let selectCallCount = 0;

  const makeFakeTx = () => ({
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: unknown) => {
            selectCallCount++;
            if (selectCallCount === 1) return mocks.selectSchema();
            return mocks.selectRel();
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(),
      }),
    }),
  });

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      selectCallCount = 0;
      return fn(makeFakeTx());
    },
  };
});

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaRelationshipDeleteHandler } from "./schema.relationship.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = { draftVersionId: "ver-draft-1" };
const SCHEMA_ROW = { id: "schema-internal-1" };
const REL_ROW = { id: "rel-internal-1" };

const BASE_INPUT = { schemaName: "core", name: "PAID_BY" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaRelationshipDeleteHandler", () => {
  describe("no draft version", () => {
    it("returns deleted=false without touching DB", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue({ draftVersionId: null });
      const result = await schemaRelationshipDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.relationshipTypeName).toBe(BASE_INPUT.name);
    });
  });

  describe("schema not found in draft", () => {
    it("returns deleted=false when schema does not exist", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectSchema.mockResolvedValue([]);
      const result = await schemaRelationshipDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
    });
  });

  describe("relationship type not found", () => {
    it("returns deleted=false when relationship type does not exist", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectRel.mockResolvedValue([]);
      const result = await schemaRelationshipDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns deleted=true and correct relationshipTypeName", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectRel.mockResolvedValue([REL_ROW]);
      const result = await schemaRelationshipDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(true);
      expect(result.relationshipTypeName).toBe(BASE_INPUT.name);
    });

    it("calls getOrCreateRegistry with correct orgId/workspaceId/userId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectRel.mockResolvedValue([REL_ROW]);
      await schemaRelationshipDeleteHandler(BASE_INPUT, CTX);
      expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        CTX.userId,
      );
    });
  });
});
