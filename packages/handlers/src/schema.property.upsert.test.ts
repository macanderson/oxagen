/**
 * schema.property.upsert handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb) — resolves owner (nodeLabel or relType), then upserts property
 *   - ./schema.versioning (getOrCreateRegistry)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectOwner: vi.fn(), // first select inside tx — resolves the owner
  selectProp: vi.fn(), // second select — checks for existing property
  updateProp: vi.fn(),
  insertProp: vi.fn(),
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
        where: (_cond: unknown) => ({
          returning: mocks.updateProp,
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        returning: mocks.insertProp,
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

import { schemaPropertyUpsertHandler } from "./schema.property.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = { draftVersionId: "ver-draft-1" };
const LABEL_ROW = { id: "lbl-internal-1", publicId: "lbl_123" };
const REL_ROW = { id: "rel-internal-1", publicId: "rel_456" };
const PROP_EXISTING = {
  id: "prop-internal-1",
  publicId: "prop_existing",
  description: null,
  enumValues: null,
  itemType: null,
  constraints: {},
  example: null,
};
const PROP_INSERTED = { publicId: "prop_new_1" };

const NODE_INPUT = {
  ownerKind: "node" as const,
  ownerName: "Payment",
  key: "amount",
  dataType: "string" as const,
  required: true,
};

const REL_INPUT = {
  ownerKind: "relationship" as const,
  ownerName: "PAID_BY",
  key: "amount",
  dataType: "number" as const,
  required: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaPropertyUpsertHandler", () => {
  describe("no draft version", () => {
    it("throws when draftVersionId is null", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue({ draftVersionId: null });
      await expect(
        schemaPropertyUpsertHandler(NODE_INPUT, CTX),
      ).rejects.toThrow("No draft version found for registry");
    });
  });

  describe("node property — create path", () => {
    it("returns created=true and the new propertyId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([]);
      mocks.insertProp.mockResolvedValue([PROP_INSERTED]);

      const result = await schemaPropertyUpsertHandler(NODE_INPUT, CTX);
      expect(result.created).toBe(true);
      expect(result.propertyId).toBe("prop_new_1");
    });

    it("throws when node label is not found in draft", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([]);
      await expect(
        schemaPropertyUpsertHandler(NODE_INPUT, CTX),
      ).rejects.toThrow(
        `Node label "${NODE_INPUT.ownerName}" not found in draft`,
      );
    });

    it("throws when property insert returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([]);
      mocks.insertProp.mockResolvedValue([]);
      await expect(
        schemaPropertyUpsertHandler(NODE_INPUT, CTX),
      ).rejects.toThrow(`Failed to insert property ${NODE_INPUT.key}`);
    });
  });

  describe("node property — update path", () => {
    it("returns created=false with the existing propertyId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_EXISTING]);
      mocks.updateProp.mockResolvedValue([{ publicId: "prop_existing" }]);

      const result = await schemaPropertyUpsertHandler(NODE_INPUT, CTX);
      expect(result.created).toBe(false);
      expect(result.propertyId).toBe("prop_existing");
    });

    it("falls back to existing.publicId when update returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([LABEL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_EXISTING]);
      mocks.updateProp.mockResolvedValue([]);

      const result = await schemaPropertyUpsertHandler(NODE_INPUT, CTX);
      expect(result.propertyId).toBe(PROP_EXISTING.publicId);
    });
  });

  describe("relationship property — create path", () => {
    it("returns created=true for a new relationship property", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([REL_ROW]);
      mocks.selectProp.mockResolvedValue([]);
      mocks.insertProp.mockResolvedValue([{ publicId: "prop_rel_new" }]);

      const result = await schemaPropertyUpsertHandler(REL_INPUT, CTX);
      expect(result.created).toBe(true);
      expect(result.propertyId).toBe("prop_rel_new");
    });

    it("throws when relationship type is not found in draft", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([]);
      await expect(schemaPropertyUpsertHandler(REL_INPUT, CTX)).rejects.toThrow(
        `Relationship type "${REL_INPUT.ownerName}" not found in draft`,
      );
    });
  });

  describe("relationship property — update path", () => {
    it("returns created=false for an existing relationship property", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.selectOwner.mockResolvedValue([REL_ROW]);
      mocks.selectProp.mockResolvedValue([PROP_EXISTING]);
      mocks.updateProp.mockResolvedValue([{ publicId: "prop_existing" }]);

      const result = await schemaPropertyUpsertHandler(REL_INPUT, CTX);
      expect(result.created).toBe(false);
    });
  });
});
