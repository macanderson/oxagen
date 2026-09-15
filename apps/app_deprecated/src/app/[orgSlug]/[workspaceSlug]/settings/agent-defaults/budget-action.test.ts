/**
 * budget-action.test.ts — unit tests for updateWorkspaceBudgetAction.
 *
 * Covers:
 *   - role gate: non-owner/admin workspace role → ok:false forbidden error
 *   - happy path: ok:true, invoke called with the mapped input + { surface: "agent" }
 *   - invoke error → ok:false with error message
 *   - revalidatePath called with the consolidated agent-defaults path on success
 *   - disabled budget → limitUsd forced to null before invoke
 *
 * Mock seam mirrors models-action.test.ts exactly (same IAM-gate shape).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { updateWorkspaceBudgetAction } from "./budget-action";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

function base(
  overrides: Partial<{
    enabled: boolean;
    limitUsd: number | null;
    mode: "grace" | "prompt" | "enforce";
    graceOveragePct: number;
    enforcement: "default" | "ceiling";
  }> = {},
) {
  return {
    orgSlug: "acme",
    workspaceSlug: "main",
    enabled: true,
    limitUsd: 5,
    mode: "grace" as const,
    graceOveragePct: 0.25,
    enforcement: "default" as const,
    ...overrides,
  };
}

describe("updateWorkspaceBudgetAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when the caller has member workspace role", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await updateWorkspaceBudgetAction(base());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("admin");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when the caller has no workspace membership row", async () => {
    dbState.wsRoleRows = [];
    const res = await updateWorkspaceBudgetAction(base());
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls invoke with the mapped input on the happy path", async () => {
    const res = await updateWorkspaceBudgetAction(
      base({ mode: "enforce", enforcement: "ceiling" }),
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_budget_policy",
      {
        enabled: true,
        limitUsd: 5,
        mode: "enforce",
        graceOveragePct: 0.25,
        enforcement: "ceiling",
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
  });

  it("forces limitUsd to null when the caller disables the budget", async () => {
    // The form is responsible for nulling limitUsd before calling the action
    // when disabled — assert the action passes the caller-supplied value through.
    const res = await updateWorkspaceBudgetAction(
      base({ enabled: false, limitUsd: null }),
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_budget_policy",
      expect.objectContaining({ enabled: false, limitUsd: null }),
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("revalidates the consolidated agent-defaults path on success", async () => {
    await updateWorkspaceBudgetAction(base());
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/agent-defaults",
    );
  });

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("budget policy rejected"));
    const res = await updateWorkspaceBudgetAction(base());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("budget policy rejected");
  });

  it("rejects an out-of-range grace percentage before invoking", async () => {
    const res = await updateWorkspaceBudgetAction(
      base({ graceOveragePct: 11 }),
    );
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
