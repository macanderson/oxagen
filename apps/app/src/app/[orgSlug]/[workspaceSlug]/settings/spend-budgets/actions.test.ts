/**
 * actions.test.ts — unit tests for the Spend Budgets server actions.
 *
 * The gate is role-conditional: getSpendBudgetsAction reads at Member level
 * (assertOrgMember — mirrors get_spend_budget's own `defaultRoles`, which
 * allow any org/workspace Member to read); setSpendBudgetAction writes at
 * billing-manager level (assertBillingManager). A Member who can see the
 * burn cannot raise the ceiling.
 *
 * Mocking strategy:
 *   - @/lib/session → vi.mock (getSession)
 *   - @/lib/resolve-org → vi.mock (resolveOrg, resolveWorkspace,
 *     assertOrgMember, assertBillingManager — both assert helpers mocked
 *     independently so a test can grant one role and deny the other)
 *   - @oxagen/tenancy → vi.mock (runInTenantScope invokes its callback inline)
 *   - @oxagen/oxagen → vi.mock (invoke)
 *   - @oxagen/handlers/register → vi.mock (no-op side effect)
 *   - next/cache → vi.mock (revalidatePath)
 *   - @/lib/routes → vi.mock (workspace.settings.spendBudgets)
 *
 * Coverage:
 *   1. unauthenticated (no session) → {ok:false} on both actions, invoke not called
 *   2. Member (assertOrgMember resolves, assertBillingManager rejects):
 *      CAN read → {ok:true}; CANNOT write → {ok:false, NOT_AUTHORIZED
 *      message}, invoke not called
 *   3. Non-member (assertOrgMember rejects) → getSpendBudgetsAction
 *      {ok:false, NOT_A_MEMBER message}, invoke not called
 *   4. Billing manager (assertBillingManager resolves) → setSpendBudgetAction
 *      succeeds; assertOrgMember is irrelevant to the write gate (never
 *      called for role="billingManager")
 *   5. getSpendBudgetsAction happy path → {ok:true, budgets:[org, workspace]},
 *      including a disabled ceiling passed through unchanged
 *   6. setSpendBudgetAction happy path → {ok:true, budget}, revalidatePath called
 *   7. invoke throws on get / set → {ok:false, error message}
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRunInTenantScope,
  mockInvoke,
  mockRevalidatePath,
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockAssertBillingManager,
} = vi.hoisted(() => ({
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockAssertBillingManager: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  assertBillingManager: mockAssertBillingManager,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      spendBudgets: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/settings/spend-budgets`,
    },
  },
}));

import { getSpendBudgetsAction, setSpendBudgetAction } from "./actions";
import type { SpendBudgetStatus } from "./spend-budget-format";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", publicId: "pub-org-1", name: "Acme", slug: "acme" };
const WS = {
  id: "ws-1",
  publicId: "pub-ws-1",
  orgId: "org-1",
  name: "Main",
  slug: "main",
};

function orgBudget(
  overrides: Partial<SpendBudgetStatus> = {},
): SpendBudgetStatus {
  return {
    scope: "org",
    publicId: "bdg_org1",
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitUsd: 1000,
    spentUsd: 250,
    projectedUsd: 500,
    ratio: 0.25,
    state: "ok",
    reachedThreshold: 0,
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function workspaceBudget(
  overrides: Partial<SpendBudgetStatus> = {},
): SpendBudgetStatus {
  return {
    ...orgBudget(),
    scope: "workspace",
    publicId: "bdg_ws1",
    limitUsd: 100,
    spentUsd: 96,
    ratio: 0.96,
    state: "threshold_95",
    reachedThreshold: 95,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  // Default: both roles granted. Individual describe blocks narrow this to
  // exercise the split gate.
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockAssertBillingManager.mockResolvedValue(undefined);
});

describe("unauthenticated — no session", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(null);
  });

  it("getSpendBudgetsAction returns {ok:false} without calling invoke", async () => {
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("setSpendBudgetAction returns {ok:false} without calling invoke", async () => {
    const result = await setSpendBudgetAction("acme", "main", {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      limitUsd: 100,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("Member — can read, cannot write", () => {
  beforeEach(() => {
    // Member: org membership holds, billing-manager role does not.
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockAssertBillingManager.mockRejectedValue(new Error("not found"));
  });

  it("getSpendBudgetsAction succeeds ({ok:true}) for a plain Member", async () => {
    mockInvoke.mockResolvedValue({ budgets: [orgBudget()] });
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(true);
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockAssertBillingManager).not.toHaveBeenCalled();
  });

  it("setSpendBudgetAction fails ({ok:false}) with the billing-manager message for the same Member, invoke not called", async () => {
    const result = await setSpendBudgetAction("acme", "main", {
      scope: "org",
      enabled: true,
      period: "monthly",
      limitUsd: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "You don't have permission to manage spend budgets for this workspace.",
      );
    }
    expect(mockInvoke).not.toHaveBeenCalled();
    // The write gate checks billing-manager only — it never re-derives
    // membership via assertOrgMember for role="billingManager".
    expect(mockAssertOrgMember).not.toHaveBeenCalled();
  });
});

describe("non-member — assertOrgMember denies", () => {
  beforeEach(() => {
    mockAssertOrgMember.mockRejectedValue(new Error("not found"));
  });

  it("getSpendBudgetsAction returns {ok:false} with the member-access message, invoke not called", async () => {
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("You don't have access to this workspace.");
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("non-billing-manager — assertBillingManager denies", () => {
  beforeEach(() => {
    mockAssertBillingManager.mockRejectedValue(new Error("not found"));
  });

  it("setSpendBudgetAction returns {ok:false, error} mentioning permission, invoke not called", async () => {
    const result = await setSpendBudgetAction("acme", "main", {
      scope: "org",
      enabled: true,
      period: "monthly",
      limitUsd: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permission");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("billing manager — can read and write", () => {
  it("getSpendBudgetsAction succeeds for a billing manager", async () => {
    mockInvoke.mockResolvedValue({ budgets: [orgBudget()] });
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(true);
  });

  it("setSpendBudgetAction succeeds for a billing manager", async () => {
    mockInvoke.mockResolvedValue(orgBudget());
    const result = await setSpendBudgetAction("acme", "main", {
      scope: "org",
      enabled: true,
      period: "monthly",
      limitUsd: 1000,
    });
    expect(result.ok).toBe(true);
  });
});

describe("getSpendBudgetsAction — happy path", () => {
  it("returns {ok:true, budgets} with both scopes, invoking get_spend_budget with {} input inside tenant scope", async () => {
    mockInvoke.mockResolvedValue({ budgets: [orgBudget(), workspaceBudget()] });

    const result = await getSpendBudgetsAction("acme", "main");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.budgets).toHaveLength(2);
      expect(result.budgets[0]?.scope).toBe("org");
      expect(result.budgets[1]?.scope).toBe("workspace");
    }
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_spend_budget",
      {},
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRunInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      expect.any(Function),
    );
  });

  it("returns {ok:true, budgets: []} when neither scope has a configured ceiling", async () => {
    mockInvoke.mockResolvedValue({ budgets: [] });
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.budgets).toEqual([]);
  });

  it("passes a disabled ceiling through unchanged (the store now returns disabled rows too)", async () => {
    const disabled = workspaceBudget({
      enabled: false,
      state: "exceeded",
      ratio: 1.4,
    });
    mockInvoke.mockResolvedValue({ budgets: [disabled] });
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.budgets[0]).toEqual(disabled);
  });
});

describe("getSpendBudgetsAction — invoke throws", () => {
  it("returns {ok:false, error} with the thrown message", async () => {
    mockInvoke.mockRejectedValue(new Error("budget read failed"));
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("budget read failed");
  });
});

describe("setSpendBudgetAction — happy path", () => {
  it("returns {ok:true, budget} and revalidates the spend-budgets path", async () => {
    const updated = workspaceBudget({
      limitUsd: 200,
      spentUsd: 96,
      ratio: 0.48,
      state: "ok",
    });
    mockInvoke.mockResolvedValue(updated);

    const result = await setSpendBudgetAction("acme", "main", {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      limitUsd: 200,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.budget).toEqual(updated);
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_spend_budget",
      { scope: "workspace", enabled: true, period: "monthly", limitUsd: 200 },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/spend-budgets",
    );
  });

  it("passes a rolling period's windowDays through to invoke unchanged", async () => {
    mockInvoke.mockResolvedValue(
      orgBudget({ period: "rolling", windowDays: 14 }),
    );

    await setSpendBudgetAction("acme", "main", {
      scope: "org",
      enabled: true,
      period: "rolling",
      windowDays: 14,
      limitUsd: 1000,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_spend_budget",
      {
        scope: "org",
        enabled: true,
        period: "rolling",
        windowDays: 14,
        limitUsd: 1000,
      },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("re-enabling a disabled ceiling sends enabled:true through to invoke", async () => {
    mockInvoke.mockResolvedValue(workspaceBudget({ enabled: true }));

    await setSpendBudgetAction("acme", "main", {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      limitUsd: 100,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_spend_budget",
      expect.objectContaining({ enabled: true }),
      expect.anything(),
      { surface: "agent" },
    );
  });
});

describe("setSpendBudgetAction — invoke throws", () => {
  it("returns {ok:false, error} with the thrown message and does not revalidate", async () => {
    mockInvoke.mockRejectedValue(
      new Error("windowDays is required for period 'rolling'"),
    );

    const result = await setSpendBudgetAction("acme", "main", {
      scope: "org",
      enabled: true,
      period: "rolling",
      windowDays: null,
      limitUsd: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe("windowDays is required for period 'rolling'");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
