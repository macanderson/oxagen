/**
 * memory-policy-actions.test.ts — unit tests for saveMemoryPolicyAction and
 * readMemoryPolicyAction.
 *
 * Covers:
 *   - save: zod validation rejects out-of-range input before invoke
 *   - save: role gate — memory policy is OWNER-ONLY (stricter than the other
 *     agent-defaults sub-tabs, which allow owner+admin) — preserved verbatim
 *     from the pre-move behavior.
 *   - save: happy path invokes update_memory_policy + { surface: "agent" }
 *     and revalidates the consolidated agent-defaults path.
 *   - save: invoke error → ok:false with error message.
 *   - read: asserts org membership then invokes get_memory_policy and returns
 *     the raw result.
 *
 * Mock seam mirrors models-action.test.ts / budget-action.test.ts.
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
vi.mock("@oxagen/agent/register", () => ({}));
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

import {
  saveMemoryPolicyAction,
  readMemoryPolicyAction,
} from "./memory-policy-actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

function base(overrides: Record<string, number> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "main",
    halfLifeLowDays: 30,
    halfLifeHighDays: 90,
    recallThreshold: 0.1,
    complianceThreshold: 70,
    defaultDecayFloor: 5,
    ...overrides,
  };
}

describe("saveMemoryPolicyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("rejects an out-of-range recall threshold before invoking", async () => {
    const res = await saveMemoryPolicyAction(base({ recallThreshold: 2 }));
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects a non-owner workspace role (owner-only, stricter than models/budget/prompts)", async () => {
    dbState.wsRoleRows = [{ role: "admin" }];
    const res = await saveMemoryPolicyAction(base());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("owner");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and invokes update_memory_policy with { surface: 'agent' } on the happy path", async () => {
    const res = await saveMemoryPolicyAction(base());
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_memory_policy",
      {
        halfLifeLowDays: 30,
        halfLifeHighDays: 90,
        recallThreshold: 0.1,
        complianceThreshold: 70,
        defaultDecayFloor: 5,
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
  });

  it("revalidates the consolidated agent-defaults path on success", async () => {
    await saveMemoryPolicyAction(base());
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/agent-defaults",
    );
  });

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("memory policy rejected"));
    const res = await saveMemoryPolicyAction(base());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("memory policy rejected");
  });
});

describe("readMemoryPolicyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    });
  });

  it("asserts org membership then invokes get_memory_policy and returns the result", async () => {
    const result = await readMemoryPolicyAction({
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_memory_policy",
      {},
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(result).toEqual({
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    });
  });
});
