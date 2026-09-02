/**
 * schema.property.delete handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb)
 *   - ./schema.versioning (getOrCreateRegistry)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectOwner: vi.fn(), // resolves owner (nodeLabel or relType)
  selectProp: vi.fn(), // resolves property row
  updateProp: vi.fn(),
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
            if (selectCallCount === 1) return mocks.selectOwner();
            return mocks.selectProp();
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

import { schemaPropertyDeleteHandler } from "./schema.property.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = { draftVersionId: "ver-draft-1" };
const LABEL_ROW = { id: "lbl-internal-1" };
const REL_ROW = { id: "rel-internal-1" };
const PROP_ROW = { id: "prop-internal-1" };

const NODE_INPUT = {
  ownerKind: "node" as const,
  ownerName: "Payment",
  key: "amount",
};

const REL_INPUT = {
  ownerKind: "relationship" as const,
  ownerName: "PAID_BY",
  key: "since",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaPropertyDeleteHandler", () => {
  describe("no draft version", () => {
    it("returns deleted=false and correct propertyKey without touching DB", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue({ draftVersionId: null });
      const result = await schemaPropertyDeleteHandler(NODE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.propertyKey).toBe(NODE_INPUT.key);
    });
  });

  describe("node property — owner not found", () => {
    it("returns deleted=false when node label is not in draft", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([]);
      const result = await schemaPropertyDeleteHandler(NODE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.propertyKey).toBe(NODE_INPUT.key);
    });
  });

  describe("node property — property not found", () => {
    it("returns deleted=false when the property row does not exist", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([]);
      const result = await schemaPropertyDeleteHandler(NODE_INPUT, CTX);
      expect(result.deleted).toBe(false);
    });
  });

  describe("node property — happy path", () => {
    it("returns deleted=true and the correct propertyKey", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_ROW]);
      const result = await schemaPropertyDeleteHandler(NODE_INPUT, CTX);
      expect(result.deleted).toBe(true);
      expect(result.propertyKey).toBe(NODE_INPUT.key);
    });

    it("calls getOrCreateRegistry with the correct args", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_ROW]);
      await schemaPropertyDeleteHandler(NODE_INPUT, CTX);
      expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        CTX.userId,
      );
    });
  });

  describe("relationship property — owner not found", () => {
    it("returns deleted=false when relationship type is not in draft", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([]);
      const result = await schemaPropertyDeleteHandler(REL_INPUT, CTX);
      expect(result.deleted).toBe(false);
    });
  });

  describe("relationship property — happy path", () => {
    it("returns deleted=true for a found relationship property", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([REL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_ROW]);
      const result = await schemaPropertyDeleteHandler(REL_INPUT, CTX);
      expect(result.deleted).toBe(true);
      expect(result.propertyKey).toBe(REL_INPUT.key);
    });
  });
});
