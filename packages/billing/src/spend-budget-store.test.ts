/**
 * spend-budget-store.test.ts — the scope-read half of the spend-budget store.
 *
 * The distinction under test is load-bearing: the ENFORCEMENT path
 * (getScopeBudgets) must see only enabled ceilings, while the PANEL path
 * (getAllScopeBudgets) must see disabled ones too. Filtering disabled rows out
 * of the panel stranded them — the panel is the only surface that can turn a
 * ceiling back on, so an invisible row was unrecoverable.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

/** Captures the where() clause so a test can assert whether one was applied. */
const selectChain = {
  from: vi.fn(() => selectChain),
  where: vi.fn(() => selectChain),
};

const dbMocks = {
  select: vi.fn(() => selectChain),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
});

const { getScopeBudgets, getAllScopeBudgets } = await import(
  "./spend-budget-store"
);

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bdg-1",
    publicId: "sb_1",
    orgId: "org-1",
    workspaceId: null,
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitMicros: "500000000",
    notifiedThreshold: 0,
    notifiedPeriodStart: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getScopeBudgets — the enforcement read", () => {
  it("filters to enabled ceilings only", async () => {
    selectChain.where.mockReturnValueOnce([row()]);

    const budgets = await getScopeBudgets();

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.enabled).toBe(true);
  });
});

describe("getAllScopeBudgets — the panel read", () => {
  it("applies no enabled filter, so a disabled ceiling is still returned", async () => {
    selectChain.from.mockReturnValueOnce([row({ enabled: false })]);

    const budgets = await getAllScopeBudgets();

    // No .where() — a disabled ceiling must survive to reach the panel that
    // is the only surface capable of re-enabling it.
    expect(selectChain.where).not.toHaveBeenCalled();
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.enabled).toBe(false);
  });

  it("orders the org-level ceiling before the workspace ceiling", async () => {
    selectChain.from.mockReturnValueOnce([
      row({ id: "bdg-ws", publicId: "sb_ws", workspaceId: "ws-1" }),
      row({ id: "bdg-org", publicId: "sb_org", workspaceId: null }),
    ]);

    const budgets = await getAllScopeBudgets();

    expect(budgets.map((b) => b.scope)).toEqual(["org", "workspace"]);
  });

  it("maps a null workspaceId to org scope and a set one to workspace scope", async () => {
    selectChain.from.mockReturnValueOnce([
      row({ workspaceId: "ws-9", limitMicros: "125000000" }),
    ]);

    const budgets = await getAllScopeBudgets();

    expect(budgets[0]).toMatchObject({
      scope: "workspace",
      workspaceId: "ws-9",
      limitMicros: 125_000_000n,
    });
  });
});
