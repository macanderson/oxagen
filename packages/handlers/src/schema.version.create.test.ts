import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  publishDraft: vi.fn(),
  invalidatePinnedSchemaCache: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
  publishDraft: mocks.publishDraft,
}));

vi.mock("./schema.pinned", () => ({
  invalidatePinnedSchemaCache: mocks.invalidatePinnedSchemaCache,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaVersionCreateHandler } from "./schema.version.create";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg-internal-id",
  publicId: "scr_abc",
  pinnedVersionId: null as string | null,
  draftVersionId: "draft-version-id" as string | null,
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

const PUBLISHED = {
  versionId: "scv_v2",
  versionNumber: 2,
  publishedAt: "2026-01-01T00:00:00.000Z",
  newDraftVersionId: "draft-v3-id",
};

describe("schemaVersionCreateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
    mocks.publishDraft.mockResolvedValue(PUBLISHED);
    mocks.invalidatePinnedSchemaCache.mockResolvedValue(undefined);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("publishes draft and returns version info", async () => {
    const result = await schemaVersionCreateHandler(
      { label: "v2", changeSummary: "initial release" },
      CTX,
    );

    expect(result.versionId).toBe("scv_v2");
    expect(result.versionNumber).toBe(2);
    expect(result.publishedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("calls publishDraft with correct arguments", async () => {
    await schemaVersionCreateHandler(
      { label: "v2", changeSummary: "first" },
      CTX,
    );

    expect(mocks.publishDraft).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
      BASE_REGISTRY.id,
      BASE_REGISTRY.draftVersionId,
      CTX.userId,
      "v2",
      "first",
    );
  });

  it("calls invalidatePinnedSchemaCache with workspaceId after publish", async () => {
    await schemaVersionCreateHandler({}, CTX);

    expect(mocks.invalidatePinnedSchemaCache).toHaveBeenCalledWith(
      CTX.workspaceId,
    );
    expect(mocks.invalidatePinnedSchemaCache).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache AFTER publishDraft completes", async () => {
    const order: string[] = [];
    mocks.publishDraft.mockImplementation(async () => {
      order.push("publishDraft");
      return PUBLISHED;
    });
    mocks.invalidatePinnedSchemaCache.mockImplementation(async () => {
      order.push("invalidate");
    });

    await schemaVersionCreateHandler({}, CTX);

    expect(order).toEqual(["publishDraft", "invalidate"]);
  });

  it("calls handler without label/changeSummary (optional fields)", async () => {
    const result = await schemaVersionCreateHandler({}, CTX);
    expect(result.versionId).toBe("scv_v2");
    // publishDraft called with undefined for optional fields
    expect(mocks.publishDraft).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
      BASE_REGISTRY.id,
      BASE_REGISTRY.draftVersionId,
      CTX.userId,
      undefined,
      undefined,
    );
  });

  // ── error path ────────────────────────────────────────────────────────────

  it("throws when registry has no draftVersionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      ...BASE_REGISTRY,
      draftVersionId: null,
    });

    await expect(schemaVersionCreateHandler({}, CTX)).rejects.toThrow(
      "No draft version found for registry",
    );
    expect(mocks.publishDraft).not.toHaveBeenCalled();
    expect(mocks.invalidatePinnedSchemaCache).not.toHaveBeenCalled();
  });

  it("propagates publishDraft errors without swallowing them", async () => {
    mocks.publishDraft.mockRejectedValue(
      new Error("Failed to publish draft version"),
    );

    await expect(schemaVersionCreateHandler({}, CTX)).rejects.toThrow(
      "Failed to publish draft version",
    );
    expect(mocks.invalidatePinnedSchemaCache).not.toHaveBeenCalled();
  });
});
