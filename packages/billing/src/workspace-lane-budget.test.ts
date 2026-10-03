// #5426: the workspace's own daily budget on each lane of its model calls.
// The gate reads the setting and today's counter row, refuses once the lane's
// spend reaches the limit, and fails open when it cannot read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: null as unknown,
  spentMicros: 0n,
  settingsRead: vi.fn(),
  counterRead: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              await mocks.settingsRead();
              return [{ settings: mocks.settings }];
            },
          }),
        }),
      }),
    });
  // ADR-086: a seam that substitutes withTenantDb must substitute withOrgDb
  // too, or the real one raises TenantScopeError under the test.
  return { ...original, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("./spend-counter", () => ({
  sumLaneSpendForDay: async (args: unknown) => {
    await mocks.counterRead(args);
    return mocks.spentMicros;
  },
}));
vi.mock("./logger", () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { assertUnderWorkspaceLaneBudget, laneBudgetStanding, WorkspaceBudgetSpentError } =
  await import("./workspace-lane-budget");

const scope = {
  orgId: "00000000-0000-0000-0000-00000000a111",
  workspaceId: "00000000-0000-0000-0000-00000000b222",
};

beforeEach(() => {
  mocks.settings = null;
  mocks.spentMicros = 0n;
  mocks.settingsRead.mockReset().mockResolvedValue(undefined);
  mocks.counterRead.mockReset().mockResolvedValue(undefined);
  mocks.loggerError.mockReset();
  mocks.loggerWarn.mockReset();
});

describe("assertUnderWorkspaceLaneBudget", () => {
  it("admits every call when the lane has no budget, and reads no counter", async () => {
    mocks.settings = { runEnrichmentEnabled: true };
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "run_enrichment" }),
    ).resolves.toBeUndefined();
    expect(mocks.counterRead).not.toHaveBeenCalled();
  });

  it("admits a call while today's spend is under the lane's budget", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: 2, assistant: null, work: 1 } };
    mocks.spentMicros = 1_999_999n;
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "run_enrichment" }),
    ).resolves.toBeUndefined();
    expect(mocks.counterRead).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "run_enrichment", ...scope }),
    );
  });

  it("refuses once today's spend reaches the budget, naming the lane and the amounts", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: 2, assistant: 0.5, work: null } };
    mocks.spentMicros = 2_000_000n;
    const refusal = assertUnderWorkspaceLaneBudget({ ...scope, lane: "run_enrichment" });
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceBudgetSpentError);
    await expect(refusal).rejects.toMatchObject({
      code: "workspace_budget_spent",
      lane: "run_enrichment",
      budgetUsd: 2,
      spentUsd: 2,
    });
    await expect(refusal).rejects.toThrow(/run enrichment.*\$2\.00 of \$2\.00.*00:00 UTC/);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("holds each lane to its own budget: a spent assistant lane does not refuse work", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: null, assistant: 0.5, work: 5 } };
    mocks.spentMicros = 500_000n;
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "assistant" }),
    ).rejects.toThrow(/Stella chat/);
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "work" }),
    ).resolves.toBeUndefined();
  });

  it("treats a zero budget as a lane switched off", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: 0, assistant: null, work: null } };
    mocks.spentMicros = 0n;
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "run_enrichment" }),
    ).rejects.toThrow(/\$0\.00 of \$0\.00/);
  });

  it("reads a malformed setting as no budget (negative)", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: "2", assistant: -1, work: Number.NaN } };
    mocks.spentMicros = 9_000_000n;
    for (const lane of ["run_enrichment", "assistant", "work"] as const)
      await expect(
        assertUnderWorkspaceLaneBudget({ ...scope, lane }),
      ).resolves.toBeUndefined();
  });

  it("fails OPEN when the setting or the counter cannot be read, and says so", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: 1, assistant: null, work: null } };
    mocks.counterRead.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      assertUnderWorkspaceLaneBudget({ ...scope, lane: "run_enrichment" }),
    ).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "billing_workspace_lane_budget_failed_open" }),
      expect.any(String),
    );
  });
});

describe("laneBudgetStanding", () => {
  it("reports the budget and today's spend in dollars", async () => {
    mocks.settings = { dailyBudgetUsd: { runEnrichment: null, assistant: 3, work: null } };
    mocks.spentMicros = 1_250_000n;
    await expect(laneBudgetStanding({ ...scope, lane: "assistant" })).resolves.toEqual({
      lane: "assistant",
      budgetUsd: 3,
      spentUsd: 1.25,
      ok: true,
    });
    await expect(laneBudgetStanding({ ...scope, lane: "work" })).resolves.toEqual({
      lane: "work",
      budgetUsd: null,
      spentUsd: 0,
      ok: true,
    });
  });
});
