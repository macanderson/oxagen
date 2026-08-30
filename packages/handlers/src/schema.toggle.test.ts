import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // schema.versioning mocks
  getOrCreateRegistry: vi.fn(),
  isDraftDirty: vi.fn(),
  publishDraft: vi.fn(),
  pinVersion: vi.fn(),
  // schema.pinned mock
  invalidatePinnedSchemaCache: vi.fn(),
  // DB select chain (for upsert)
  selectResult: vi.fn(),
  updateSet: vi.fn(),
  insertValues: vi.fn(),
  // resolvePublicId select
  resolveSelect: vi.fn(),
}));

// Track withTenantDb calls to differentiate the upsert call from resolvePublicId calls
let withTenantDbCallCount = 0;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      withTenantDbCallCount++;
      const call = withTenantDbCallCount;

      if (call === 1) {
        // Main upsert call - returns a tx with select chain
        return fn({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => mocks.selectResult(),
              }),
            }),
          }),
          update: () => ({
            set: () => ({
              where: mocks.updateSet,
            }),
          }),
          insert: () => ({
            values: mocks.insertValues,
          }),
        });
      }

      // Subsequent calls are resolvePublicId calls
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => mocks.resolveSelect(),
            }),
          }),
        }),
      });
    },
  };
});

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: (...args: unknown[]) =>
    mocks.getOrCreateRegistry(...args),
  isDraftDirty: (...args: unknown[]) => mocks.isDraftDirty(...args),
  publishDraft: (...args: unknown[]) => mocks.publishDraft(...args),
  pinVersion: (...args: unknown[]) => mocks.pinVersion(...args),
}));

vi.mock("./schema.pinned", () => ({
  invalidatePinnedSchemaCache: (...args: unknown[]) =>
    mocks.invalidatePinnedSchemaCache(...args),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaToggleHandler } from "./schema.toggle";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg_1",
  pinnedVersionId: null,
  draftVersionId: "draft_ver_internal_1",
};

const BASE_INPUT = { schemaName: "Person", enabled: true };

describe("schemaToggleHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTenantDbCallCount = 0;

    // Default registry - has a draft but no pinned
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
    // Default: no existing activation row
    mocks.selectResult.mockResolvedValue([]);
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.updateSet.mockResolvedValue(undefined);
    // Draft is not dirty by default
    mocks.isDraftDirty.mockResolvedValue(false);
    // Cache invalidation is a no-op
    mocks.invalidatePinnedSchemaCache.mockReturnValue(undefined);
    // resolvePublicId fallback
    mocks.resolveSelect.mockResolvedValue([{ publicId: "scv_pub_1" }]);
  });

  // ── happy path: no existing activation row, insert new ────────────────────

  it("inserts a new activation row when none exists", async () => {
    mocks.selectResult.mockResolvedValue([]); // no existing row
    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(result.schemaName).toBe("Person");
    expect(result.enabled).toBe(true);
  });

  it("updates existing activation row when one exists", async () => {
    mocks.selectResult.mockResolvedValue([{ id: "act_1" }]); // existing row
    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(result.enabled).toBe(true);
  });

  // ── no dirty draft path ───────────────────────────────────────────────────

  it("returns publishedVersionId=null when draft is not dirty", async () => {
    mocks.isDraftDirty.mockResolvedValue(false);
    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(result.publishedVersionId).toBeNull();
    expect(result.isDowngrade).toBe(false);
    // Since enabled=true and no publish, reconcileRecommended should be false
    expect(result.reconcileRecommended).toBe(false);
    expect(mocks.invalidatePinnedSchemaCache).toHaveBeenCalledWith(
      CTX.workspaceId,
    );
  });

  it("sets reconcileRecommended=true when enabled=false and no draft publish", async () => {
    mocks.isDraftDirty.mockResolvedValue(false);
    const result = await schemaToggleHandler(
      { schemaName: "Person", enabled: false },
      CTX,
    );

    expect(result.enabled).toBe(false);
    expect(result.reconcileRecommended).toBe(true);
  });

  // ── dirty draft path ─────────────────────────────────────────────────────

  it("auto-publishes and auto-pins when draft is dirty", async () => {
    mocks.isDraftDirty.mockResolvedValue(true);
    mocks.publishDraft.mockResolvedValue({
      versionId: "scv_pub_new",
      versionNumber: 2,
      publishedAt: "2026-06-23T00:00:00.000Z",
      newDraftVersionId: "draft_ver_internal_2",
    });
    mocks.pinVersion.mockResolvedValue({
      pinnedVersionId: "scv_pub_new",
      previousVersionId: null,
      isDowngrade: false,
      reconcileRecommended: false,
    });

    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(mocks.publishDraft).toHaveBeenCalledTimes(1);
    expect(mocks.pinVersion).toHaveBeenCalledTimes(1);
    expect(result.publishedVersionId).toBe("scv_pub_new");
    expect(result.pinnedVersionId).toBe("scv_pub_new");
    expect(result.isDowngrade).toBe(false);
    expect(mocks.invalidatePinnedSchemaCache).toHaveBeenCalledWith(
      CTX.workspaceId,
    );
  });

  it("sets reconcileRecommended=true when publish results in downgrade", async () => {
    mocks.isDraftDirty.mockResolvedValue(true);
    mocks.publishDraft.mockResolvedValue({
      versionId: "scv_pub_new",
      versionNumber: 2,
      publishedAt: "2026-06-23T00:00:00.000Z",
      newDraftVersionId: "draft_ver_internal_2",
    });
    mocks.pinVersion.mockResolvedValue({
      pinnedVersionId: "scv_pub_new",
      previousVersionId: "scv_pub_old",
      isDowngrade: true,
      reconcileRecommended: true,
    });

    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(result.isDowngrade).toBe(true);
    expect(result.reconcileRecommended).toBe(true);
  });

  it("sets reconcileRecommended=true when disabling even if not downgrade", async () => {
    mocks.isDraftDirty.mockResolvedValue(true);
    mocks.publishDraft.mockResolvedValue({
      versionId: "scv_pub_new",
      versionNumber: 2,
      publishedAt: "2026-06-23T00:00:00.000Z",
      newDraftVersionId: "draft_ver_internal_2",
    });
    mocks.pinVersion.mockResolvedValue({
      pinnedVersionId: "scv_pub_new",
      previousVersionId: null,
      isDowngrade: false,
      reconcileRecommended: false,
    });

    const result = await schemaToggleHandler(
      { schemaName: "Person", enabled: false },
      CTX,
    );

    // !enabled → reconcileRecommended = true (even if not a downgrade)
    expect(result.reconcileRecommended).toBe(true);
  });

  // ── no draft at all ───────────────────────────────────────────────────────

  it("skips dirty check when registry has no draftVersionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: null,
      draftVersionId: null,
    });
    const result = await schemaToggleHandler(BASE_INPUT, CTX);

    expect(mocks.isDraftDirty).not.toHaveBeenCalled();
    expect(result.publishedVersionId).toBeNull();
  });

  // ── pinnedVersionId resolves to public id ────────────────────────────────

  it("resolves pinnedVersionId to public id when registry has one", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_id",
      draftVersionId: "draft_ver_internal_1",
    });
    mocks.isDraftDirty.mockResolvedValue(false);
    mocks.resolveSelect.mockResolvedValue([{ publicId: "scv_pinned_pub" }]);

    const result = await schemaToggleHandler(BASE_INPUT, CTX);
    expect(result.pinnedVersionId).toBe("scv_pinned_pub");
  });

  it("falls back to internalId when no publicId row found in resolvePublicId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      id: "reg_1",
      pinnedVersionId: "pinned_internal_id",
      draftVersionId: null,
    });
    mocks.isDraftDirty.mockResolvedValue(false);
    mocks.resolveSelect.mockResolvedValue([]); // no row found

    const result = await schemaToggleHandler(BASE_INPUT, CTX);
    // Falls back to the raw internal id
    expect(result.pinnedVersionId).toBe("pinned_internal_id");
  });

  // ── invalidation always called ────────────────────────────────────────────

  it("always invalidates the pinned schema cache", async () => {
    await schemaToggleHandler(BASE_INPUT, CTX);
    expect(mocks.invalidatePinnedSchemaCache).toHaveBeenCalledWith(
      CTX.workspaceId,
    );
  });
});
