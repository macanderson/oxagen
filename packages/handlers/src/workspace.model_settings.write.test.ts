import { describe, expect, it, vi, beforeEach } from "vitest";

// The handler's role gate (#4194) runs for real against a role fixture. The
// default caller is an org Owner; a case that needs another sets roleGate.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
}));

const UPDATED_ROW = {
  defaultTextTier: "fast" as const,
  defaultTextModel: "openai/gpt-5.2" as string | null,
};

// Simulate drizzle's update().set().where().returning() chain
mocks.updateReturning.mockResolvedValue([UPDATED_ROW]);
mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning });
mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => ({
      update: (_table: unknown) => ({ set: mocks.updateSet }),
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: (_table: unknown) => ({ set: mocks.updateSet }),
      }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { workspaceModelSettingsWriteHandler } from "./workspace.model_settings.write";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";
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
      { defaultTextTier: "fast", defaultTextModel: "openai/gpt-5.2" },
      CTX,
    );
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
    expect(result.defaultTextTier).toBe("fast");
    expect(result.defaultTextModel).toBe("openai/gpt-5.2");
  });

  // ── clearing a field (explicit null) ──────────────────────────────────────

  it("returns null when a field is cleared with explicit null input", async () => {
    mocks.updateReturning.mockResolvedValueOnce([
      { ...UPDATED_ROW, defaultTextModel: null },
    ]);
    const result = await workspaceModelSettingsWriteHandler(
      { defaultTextModel: null },
      CTX,
    );
    expect(result.defaultTextModel).toBeNull();
  });

  // ── empty input ───────────────────────────────────────────────────────────

  it("succeeds with empty input (only updatedById set)", async () => {
    const result = await workspaceModelSettingsWriteHandler({}, CTX);
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(result.defaultTextTier).toBe("fast");
  });
});

// Witness for the role gate (#4194). The kernel's IAM check allows every
// capability for a non-enterprise org, so without the handler's
// assertContractRole call this Member would get through and the test fails.
describe("update_model_settings role gate", () => {
  beforeEach(() => resetRoleGate());

  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(
      workspaceModelSettingsWriteHandler({ defaultTextTier: "fast" }, CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
