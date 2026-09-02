/**
 * models-action.test.ts — unit tests for updateWorkspaceModelsAction.
 *
 * Covers:
 *   - validation: invalid tier → ok:false before any DB work
 *   - role gate: non-owner/admin workspace role → ok:false forbidden error
 *   - happy path: ok:true, invoke called with correct capability input
 *   - invoke error → ok:false with error message
 *   - revalidatePath called on success
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    wsRoleRows: Array<{ role: string }>;
  }
  const dbState: DbState = { wsRoleRows: [{ role: "owner" }] };

  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      agentDefaults: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/settings/agent-defaults`,
    },
  },
}));

import { updateWorkspaceModelsAction } from "./models-action";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateWorkspaceModelsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false for an invalid tier value", async () => {
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      // @ts-expect-error — intentionally bad tier
      defaultTextTier: "ultra",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when the caller has member workspace role", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: "fast",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("admin");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when the caller has no workspace membership row", async () => {
    dbState.wsRoleRows = [];
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: "balanced",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls invoke with the right capability on success", async () => {
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: "balanced",
      defaultTextModel: "claude-sonnet",
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_model_settings",
      {
        defaultTextTier: "balanced",
        defaultTextModel: "claude-sonnet",
        defaultImageModel: null,
        defaultVideoModel: null,
      },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("revalidates the models settings path on success", async () => {
    await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: "fast",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/agent-defaults",
    );
  });

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("model not found"));
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: "precise",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("model not found");
  });

  it("accepts null tier (no preference set)", async () => {
    const res = await updateWorkspaceModelsAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(res.ok).toBe(true);
  });
});
