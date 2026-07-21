/**
 * actions.test.ts — unit tests for the Spend Budgets server actions
 * (OXA-1079).
 *
 * Mocking strategy mirrors ../../billing/revenue/actions.test.ts's gate()
 * shape (getSession → resolveOrg/resolveWorkspace → assertBillingManager):
 *   - @/lib/session → vi.mock (getSession)
 *   - @/lib/resolve-org → vi.mock (resolveOrg, resolveWorkspace, assertBillingManager)
 *   - @oxagen/tenancy → vi.mock (runInTenantScope invokes its callback inline)
 *   - @oxagen/oxagen → vi.mock (invoke)
 *   - @oxagen/handlers/register → vi.mock (no-op side effect)
 *   - next/cache → vi.mock (revalidatePath)
 *   - @/lib/routes → vi.mock (workspace.settings.spendBudgets)
 *
 * Coverage:
 *   1. unauthenticated (no session) → {ok:false} on both actions, invoke not called
 *   2. non-billing-manager (assertBillingManager throws) → {ok:false}, invoke not called
 *   3. getSpendBudgetsAction happy path → {ok:true, budgets:[org, workspace]}
 *   4. setSpendBudgetAction happy path → {ok:true, budget}, revalidatePath called
 *   5. invoke throws on get → {ok:false, error message}
 *   6. invoke throws on set → {ok:false, error message}
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRunInTenantScope,
  mockInvoke,
  mockRevalidatePath,
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertBillingManager,
} = vi.hoisted(() => ({
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertBillingManager: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
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

describe("non-billing-manager — assertBillingManager denies", () => {
  beforeEach(() => {
    mockAssertBillingManager.mockRejectedValue(new Error("not found"));
  });

  it("getSpendBudgetsAction returns {ok:false, error} mentioning permission, invoke not called", async () => {
    const result = await getSpendBudgetsAction("acme", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permission");
    expect(mockInvoke).not.toHaveBeenCalled();
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
