import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
}));

const UPDATED_ROW = {
  defaultTextTier: "fast" as const,
  defaultTextModel: null,
  defaultImageModel: "bfl/flux-2-max",
  defaultVideoModel: null,
};

// Simulate drizzle's update().set().where().returning() chain
mocks.updateReturning.mockResolvedValue([UPDATED_ROW]);
mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning });
mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      update: (_table: unknown) => ({ set: mocks.updateSet }),
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: (_table: unknown) => ({ set: mocks.updateSet }),
      }),
  };
});

import { workspaceModelSettingsWriteHandler } from "./workspace.model_settings.write";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceModelSettingsWriteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.updateWhere.mockClear();
    mocks.updateReturning.mockClear();
    mocks.updateReturning.mockResolvedValue([UPDATED_ROW]);
    mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning });
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
  });

  // ── workspace guard ───────────────────────────────────────────────────────

  it("throws when workspaceId is empty string (no workspace context)", async () => {
    const noWsCtx: CapabilityContext = { ...CTX, workspaceId: "" };
    await expect(
      workspaceModelSettingsWriteHandler({ defaultTextTier: "fast" }, noWsCtx),
    ).rejects.toThrow(
      "workspace.model.settings.write requires a workspace context",
    );
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      workspaceModelSettingsWriteHandler({ defaultTextTier: "fast" }, anonCtx),
    ).rejects.toThrow(
      "workspace.model.settings.write requires an authenticated user",
    );
  });

  // ── workspace not found ───────────────────────────────────────────────────

  it("throws when the update returns no row (workspace not found)", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    await expect(
      workspaceModelSettingsWriteHandler({ defaultTextTier: "fast" }, CTX),
    ).rejects.toThrow("workspace not found");
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("calls update().set().where().returning() and returns updated fields", async () => {
    const result = await workspaceModelSettingsWriteHandler(
      { defaultTextTier: "fast", defaultImageModel: "bfl/flux-2-max" },
      CTX,
    );
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
    expect(result.defaultTextTier).toBe("fast");
    expect(result.defaultImageModel).toBe("bfl/flux-2-max");
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── clearing a field (explicit null) ──────────────────────────────────────

  it("returns null when a field is cleared with explicit null input", async () => {
    mocks.updateReturning.mockResolvedValueOnce([
      { ...UPDATED_ROW, defaultImageModel: null },
    ]);
    const result = await workspaceModelSettingsWriteHandler(
      { defaultImageModel: null },
      CTX,
    );
    expect(result.defaultImageModel).toBeNull();
  });

  // ── empty input ───────────────────────────────────────────────────────────

  it("succeeds with empty input (only updatedByUserId set)", async () => {
    const result = await workspaceModelSettingsWriteHandler({}, CTX);
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(result.defaultTextTier).toBe("fast");
  });
});
