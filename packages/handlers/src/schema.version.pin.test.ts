import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  pinVersion: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
  pinVersion: mocks.pinVersion,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaVersionPinHandler } from "./schema.version.pin";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg-internal-id",
  publicId: "scr_abc",
  pinnedVersionId: null as string | null,
  draftVersionId: "draft-ver-id",
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

const PIN_RESULT = {
  pinnedVersionId: "scv_v2",
  previousVersionId: null as string | null,
  isDowngrade: false,
  reconcileRecommended: false,
};

describe("schemaVersionPinHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
    mocks.pinVersion.mockResolvedValue(PIN_RESULT);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns the pin result from pinVersion", async () => {
    const result = await schemaVersionPinHandler({ versionId: "scv_v2" }, CTX);

    expect(result.pinnedVersionId).toBe("scv_v2");
    expect(result.previousVersionId).toBeNull();
    expect(result.isDowngrade).toBe(false);
    expect(result.reconcileRecommended).toBe(false);
  });

  it("calls pinVersion with the correct arguments", async () => {
    await schemaVersionPinHandler({ versionId: "scv_v2" }, CTX);

    expect(mocks.pinVersion).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
      BASE_REGISTRY.id,
      BASE_REGISTRY.id, // pinVersion receives registryId twice (id, id)
      "scv_v2",
      CTX.userId,
    );
  });

  it("calls getOrCreateRegistry with ctx orgId, workspaceId, userId", async () => {
    await schemaVersionPinHandler({ versionId: "scv_v2" }, CTX);

    expect(mocks.getOrCreateRegistry).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
      CTX.userId,
    );
  });

  // ── downgrade scenario ────────────────────────────────────────────────────

  it("returns isDowngrade=true and reconcileRecommended=true for a downgrade", async () => {
    mocks.pinVersion.mockResolvedValue({
      pinnedVersionId: "scv_v1",
      previousVersionId: "scv_v3",
      isDowngrade: true,
      reconcileRecommended: true,
    });

    const result = await schemaVersionPinHandler({ versionId: "scv_v1" }, CTX);

    expect(result.isDowngrade).toBe(true);
    expect(result.reconcileRecommended).toBe(true);
    expect(result.previousVersionId).toBe("scv_v3");
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("propagates error when version not found", async () => {
    mocks.pinVersion.mockRejectedValue(
      new Error("Version scv_bad not found in registry"),
    );

    await expect(
      schemaVersionPinHandler({ versionId: "scv_bad" }, CTX),
    ).rejects.toThrow("Version scv_bad not found in registry");
  });

  it("propagates error when version is not published", async () => {
    mocks.pinVersion.mockRejectedValue(
      new Error("Version scv_draft is not published"),
    );

    await expect(
      schemaVersionPinHandler({ versionId: "scv_draft" }, CTX),
    ).rejects.toThrow("Version scv_draft is not published");
  });

  it("propagates getOrCreateRegistry errors", async () => {
    mocks.getOrCreateRegistry.mockRejectedValue(
      new Error("Failed to create registry"),
    );

    await expect(
      schemaVersionPinHandler({ versionId: "scv_v2" }, CTX),
    ).rejects.toThrow("Failed to create registry");

    expect(mocks.pinVersion).not.toHaveBeenCalled();
  });
});
