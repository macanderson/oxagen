import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  workspaceFindFirst: vi.fn(),
}));

const WS_ROW = {
  defaultTextTier: "balanced" as const,
  defaultTextModel: "anthropic/claude-sonnet-5",
  defaultImageModel: null,
  defaultVideoModel: null,
};

mocks.workspaceFindFirst.mockResolvedValue(WS_ROW);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      query: {
        workspaces: { findFirst: mocks.workspaceFindFirst },
      },
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          workspaces: { findFirst: mocks.workspaceFindFirst },
        },
      }),
  };
});

import { workspaceModelSettingsReadHandler } from "./workspace.model_settings.read";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceModelSettingsReadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.workspaceFindFirst.mockReset();
    mocks.workspaceFindFirst.mockResolvedValue(WS_ROW);
  });

  // ── workspace guard ───────────────────────────────────────────────────────

  it("throws when workspaceId is empty string (no workspace context)", async () => {
    const noWsCtx: CapabilityContext = { ...CTX, workspaceId: "" };
    await expect(
      workspaceModelSettingsReadHandler({}, noWsCtx),
    ).rejects.toThrow(
      "workspace.model.settings.read requires a workspace context",
    );
  });

  // ── workspace not found ───────────────────────────────────────────────────

  it("returns null defaults when the workspace row is not found", async () => {
    mocks.workspaceFindFirst.mockResolvedValueOnce(null);
    const result = await workspaceModelSettingsReadHandler({}, CTX);
    expect(result.defaultTextTier).toBeNull();
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns all four model settings columns", async () => {
    const result = await workspaceModelSettingsReadHandler({}, CTX);
    expect(result.defaultTextTier).toBe("balanced");
    expect(result.defaultTextModel).toBe("anthropic/claude-sonnet-5");
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── all null ──────────────────────────────────────────────────────────────

  it("returns null for all fields when workspace has no model defaults set", async () => {
    mocks.workspaceFindFirst.mockResolvedValueOnce({
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    const result = await workspaceModelSettingsReadHandler({}, CTX);
    expect(result.defaultTextTier).toBeNull();
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── uses workspaceId from context ─────────────────────────────────────────

  it("queries using the workspaceId from context", async () => {
    await workspaceModelSettingsReadHandler({}, CTX);
    expect(mocks.workspaceFindFirst).toHaveBeenCalledTimes(1);
  });
});
