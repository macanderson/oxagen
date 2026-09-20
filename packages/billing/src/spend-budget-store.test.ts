/**
 * spend-budget-store.test.ts — the scope-read half of the spend-budget store.
 *
 * The distinction under test is load-bearing: the ENFORCEMENT path
 * (getScopeBudgets) must see only enabled ceilings, while the PANEL path
 * (listSpendBudgets) must see disabled ones too. Filtering disabled rows out
 * of the panel stranded them — the panel is the only surface that can turn a
 * ceiling back on, so an invisible row was unrecoverable.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { withOrgDb, withTenantDb } from "@oxagen/database";

/**
 * Captures the where() clause so a test can assert whether one was applied.
 * The links return `unknown` so a test can substitute the awaited row array for
 * whichever link it wants to terminate the chain at.
 */
const selectChain = {
  from: vi.fn((): unknown => selectChain),
  limit: vi.fn(),
  where: vi.fn(
    (_predicate?: import("drizzle-orm").SQL): unknown => selectChain,
  ),
};

const writeChain = {
  values: vi.fn(() => writeChain),
  set: vi.fn(() => writeChain),
  where: vi.fn(() => writeChain),
  returning: vi.fn(),
};

const dbMocks = {
  insert: vi.fn(() => writeChain),
  update: vi.fn(() => writeChain),
  select: vi.fn(() => selectChain),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // Separate spies detect org writes routed through the workspace seam.
  const dbMock = {
    ...real,
    db: () => dbMocks,
    withTenantDb: vi.fn(async (fn: (tx: typeof dbMocks) => unknown) =>
      fn(dbMocks),
    ),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
  return {
    ...dbMock,
    withOrgDb: vi.fn(async (fn: (tx: typeof dbMocks) => unknown) =>
      fn(dbMocks),
    ),
  };
});

const {
  getScopeBudgets,
  listSpendBudgets,
  setSpendBudget,
  claimBudgetThreshold,
} = await import("./spend-budget-store");

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

describe("listSpendBudgets — the panel read", () => {
  it("applies no enabled filter, so a disabled ceiling is still returned", async () => {
    selectChain.from.mockReturnValueOnce([row({ enabled: false })]);

    const budgets = await listSpendBudgets();

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

    const budgets = await listSpendBudgets();

    expect(budgets.map((b) => b.scope)).toEqual(["org", "workspace"]);
  });

  it("maps a null workspaceId to org scope and a set one to workspace scope", async () => {
    selectChain.from.mockReturnValueOnce([
      row({ workspaceId: "ws-9", limitMicros: "125000000" }),
    ]);

    const budgets = await listSpendBudgets();

    expect(budgets[0]).toMatchObject({
      scope: "workspace",
      workspaceId: "ws-9",
      limitMicros: 125_000_000n,
    });
  });
});

it("reads only the organization ceiling through the org-wide seam", async () => {
  selectChain.where.mockResolvedValueOnce([]);
  await getScopeBudgets({ orgId: "org-a", workspaceId: null });
  expect(withOrgDb).toHaveBeenCalled();
  const predicate = selectChain.where.mock.calls.at(-1)?.[0];
  const query = new PgDialect().sqlToQuery(predicate!);
  expect(query.sql).toContain('"org_id" =');
  expect(query.sql).toContain('"workspace_id" is null');
  expect(query.params).toContain("org-a");
});

describe("setSpendBudget write scope", () => {
  it.each([null, "ws-1"])(
    "creates and updates a ceiling through its own scope: %s",
    async (workspaceId) => {
      const input = {
        orgId: "org-1",
        workspaceId,
        enabled: true,
        period: "monthly" as const,
        windowDays: null,
        limitMicros: 500n,
        actorUserId: null,
      };
      for (const existing of [[], [row({ workspaceId })]]) {
        vi.clearAllMocks();
        selectChain.limit.mockResolvedValueOnce(existing);
        writeChain.returning.mockResolvedValueOnce([row({ workspaceId })]);
        await setSpendBudget(input);
        expect(withOrgDb).toHaveBeenCalledTimes(workspaceId === null ? 1 : 0);
        expect(withTenantDb).toHaveBeenCalledTimes(
          workspaceId === null ? 0 : 1,
        );
        expect(
          existing.length ? dbMocks.update : dbMocks.insert,
        ).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("budget notification write scope", () => {
  it.each([null, "ws-1"])(
    "claims through the budget's scope: %s",
    async (workspaceId) => {
      writeChain.returning.mockResolvedValueOnce([{ id: "bdg-1" }]);
      expect(
        await claimBudgetThreshold({
          budgetId: "bdg-1",
          workspaceId,
          threshold: 80,
          periodStart: new Date(),
        }),
      ).toBe(true);
      expect(withOrgDb).toHaveBeenCalledTimes(workspaceId === null ? 1 : 0);
      expect(withTenantDb).toHaveBeenCalledTimes(workspaceId === null ? 0 : 1);
    },
  );
});
