/**
 * schema.label.upsert handler tests.
 *
 * Mocks:
 *   - @oxagen/database (withTenantDb) — call-count dispatch for multi-call sequences
 *   - ./schema.versioning (getOrCreateRegistry, getOrCreateDraftSchema)
 *   - ./logger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectExistingLabel: vi.fn(),
  updateLabel: vi.fn(),
  insertLabel: vi.fn(),
  selectLabelById: vi.fn(),
  selectExistingProp: vi.fn(),
  updateProp: vi.fn(),
  insertProp: vi.fn(),
  getOrCreateRegistry: vi.fn(),
  getOrCreateDraftSchema: vi.fn(),
}));

// The handler calls withTenantDb once with a tx object; inside it performs
// multiple select/update/insert chains. We build a fake tx that delegates to
// the right mock based on call order.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  // Track how many times select() has been called within the current tx invocation
  let selectCallCount = 0;

  const makeFakeTx = () => ({
    select: () => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: unknown) => {
            selectCallCount++;
            const call = selectCallCount;
            // Call 1 → check for existing label
            if (call === 1) return mocks.selectExistingLabel();
            // Call 2 → re-fetch label row by publicId (after insert/update)
            if (call === 2) return mocks.selectLabelById();
            // Call 3+ → property selects
            return mocks.selectExistingProp();
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => ({
          returning: mocks.updateLabel,
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        returning: mocks.insertLabel,
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
  getOrCreateDraftSchema: mocks.getOrCreateDraftSchema,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaLabelUpsertHandler } from "./schema.label.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = { draftVersionId: "ver-draft-1" };
const SCHEMA_ROW = { id: "schema-internal-1", publicId: "sc_abc" };

const BASE_INPUT = {
  schemaName: "core",
  name: "Payment",
  displayName: "Payment Node",
};

function setupHappy(
  overrides: { existing?: boolean; withProps?: boolean } = {},
) {
  mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
  mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });

  if (overrides.existing) {
    // Existing label found → update path
    mocks.selectExistingLabel.mockResolvedValue([
      {
        id: "lbl-internal-1",
        publicId: "lbl_existing",
        description: "old desc",
      },
    ]);
    mocks.updateLabel.mockResolvedValue([{ publicId: "lbl_existing" }]);
    mocks.selectLabelById.mockResolvedValue([{ id: "lbl-internal-1" }]);
  } else {
    // No existing label → insert path
    mocks.selectExistingLabel.mockResolvedValue([]);
    mocks.insertLabel.mockResolvedValue([{ publicId: "lbl_new_1" }]);
    mocks.selectLabelById.mockResolvedValue([{ id: "lbl-internal-new" }]);
  }

  if (overrides.withProps) {
    // No existing prop → insert path for property
    mocks.selectExistingProp.mockResolvedValue([]);
    // insertProp is called on the same `insert(...).values(...)` path but without
    // .returning() in the property branch. We reuse insertLabel mock key here;
    // the real insert chain just resolves.
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("schemaLabelUpsertHandler", () => {
  describe("create path (label does not exist)", () => {
    it("returns created=true and the new labelId", async () => {
      setupHappy();
      const result = await schemaLabelUpsertHandler(BASE_INPUT, CTX);
      expect(result.created).toBe(true);
      expect(result.labelId).toBe("lbl_new_1");
    });

    it("calls getOrCreateRegistry with the correct orgId/workspaceId/userId", async () => {
      setupHappy();
      await schemaLabelUpsertHandler(BASE_INPUT, CTX);
      expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        CTX.userId,
      );
    });

    it("calls getOrCreateDraftSchema with the correct schemaName", async () => {
      setupHappy();
      await schemaLabelUpsertHandler(BASE_INPUT, CTX);
      expect(mocks.getOrCreateDraftSchema).toHaveBeenCalledWith(
        CTX.orgId,
        CTX.workspaceId,
        REGISTRY.draftVersionId,
        BASE_INPUT.schemaName,
        CTX.userId,
        expect.anything(), // tx
      );
    });

    it("throws when insert returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingLabel.mockResolvedValue([]);
      mocks.insertLabel.mockResolvedValue([]);
      await expect(schemaLabelUpsertHandler(BASE_INPUT, CTX)).rejects.toThrow(
        `Failed to insert node label ${BASE_INPUT.name}`,
      );
    });
  });

  describe("update path (label already exists)", () => {
    it("returns created=false with the existing labelId", async () => {
      setupHappy({ existing: true });
      const result = await schemaLabelUpsertHandler(BASE_INPUT, CTX);
      expect(result.created).toBe(false);
      expect(result.labelId).toBe("lbl_existing");
    });

    it("falls back to existing.publicId when update returns no row", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue(REGISTRY);
      mocks.getOrCreateDraftSchema.mockResolvedValue({ schema: SCHEMA_ROW });
      mocks.selectExistingLabel.mockResolvedValue([
        { id: "lbl-internal-1", publicId: "lbl_fallback", description: null },
      ]);
      mocks.updateLabel.mockResolvedValue([]); // empty → falls back
      mocks.selectLabelById.mockResolvedValue([{ id: "lbl-internal-1" }]);

      const result = await schemaLabelUpsertHandler(BASE_INPUT, CTX);
      expect(result.labelId).toBe("lbl_fallback");
    });
  });

  describe("no draft version", () => {
    it("throws when draftVersionId is null", async () => {
      mocks.getOrCreateRegistry.mockResolvedValue({ draftVersionId: null });
      await expect(schemaLabelUpsertHandler(BASE_INPUT, CTX)).rejects.toThrow(
        "No draft version found for registry",
      );
    });
  });
});
