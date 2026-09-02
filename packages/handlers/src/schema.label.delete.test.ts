/**
 * schema.label.delete handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb) — selects schemas, nodeLabels; updates schemaProperties + nodeLabels
 *   - ./schema.versioning (getOrCreateRegistry)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectSchema: vi.fn(),
  selectLabel: vi.fn(),
  updateProps: vi.fn(),
  updateLabel: vi.fn(),
  getOrCreateRegistry: vi.fn(),
}));

// The handler calls withTenantDb once; inside it queries schemas, nodeLabels,
// then does two updates (schemaProperties, nodeLabels).
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
            return mocks.selectLabel();
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => {
          // First update = schemaProperties, second = nodeLabels
          return Promise.resolve();
        },
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

import { schemaLabelDeleteHandler } from "./schema.label.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_WITH_DRAFT = { draftVersionId: "ver-draft-1" };
const REGISTRY_NO_DRAFT = { draftVersionId: null };

const SCHEMA_ROW = { id: "schema-internal-1" };
const LABEL_ROW = { id: "label-internal-1" };

const BASE_INPUT = { schemaName: "core", name: "Payment" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaLabelDeleteHandler", () => {
  describe("no draft version", () => {
    it("returns deleted=false without touching DB when no draftVersionId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY_NO_DRAFT);
      const result = await schemaLabelDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.labelName).toBe(BASE_INPUT.name);
    });
  });

  describe("schema not found in draft", () => {
    it("returns deleted=false when schema row does not exist", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY_WITH_DRAFT);
      mocks.selectSchema.mockResolvedValue([]);
      const result = await schemaLabelDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.labelName).toBe(BASE_INPUT.name);
    });
  });

  describe("label not found in draft", () => {
    it("returns deleted=false when label row does not exist", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY_WITH_DRAFT);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectLabel.mockResolvedValue([]);
      const result = await schemaLabelDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(false);
      expect(result.labelName).toBe(BASE_INPUT.name);
    });
  });

  describe("happy path — label found and soft-deleted", () => {
    it("returns deleted=true and the correct labelName", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY_WITH_DRAFT);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectLabel.mockResolvedValue([LABEL_ROW]);
      const result = await schemaLabelDeleteHandler(BASE_INPUT, CTX);
      expect(result.deleted).toBe(true);
      expect(result.labelName).toBe(BASE_INPUT.name);
    });

    it("calls getOrCreateRegistry with the correct orgId/workspaceId/userId", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY_WITH_DRAFT);
      mocks.selectSchema.mockResolvedValue([SCHEMA_ROW]);
      mocks.selectLabel.mockResolvedValue([LABEL_ROW]);
      await schemaLabelDeleteHandler(BASE_INPUT, CTX);
      expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        CTX.userId,
      );
    });
  });
});
