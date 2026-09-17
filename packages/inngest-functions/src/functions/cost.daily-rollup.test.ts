import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRunsAwaitingRollup: vi.fn(),
  listWorkspacesWithRuns: vi.fn(),
  rebuildRunTotals: vi.fn(),
  rebuildDailyTotals: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  listRunsAwaitingRollup: mocks.listRunsAwaitingRollup,
  listWorkspacesWithRuns: mocks.listWorkspacesWithRuns,
  rebuildRunTotals: mocks.rebuildRunTotals,
  rebuildDailyTotals: mocks.rebuildDailyTotals,
  utcDay: (at: Date) => at.toISOString().slice(0, 10),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
let handler: Handler | null = null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (_opts: unknown, t: typeof trigger, fn: Handler) => {
    trigger = t;
    handler = fn;
    return [{}];
  },
);

await import("./cost.daily-rollup");

const step = { run: (_: string, fn: () => Promise<unknown>) => fn() };

const RUN_YESTERDAY = {
  orgId: "org-1",
  workspaceId: "ws-1",
  startedAt: new Date("2026-09-14T10:00:00.000Z"),
};

describe("cost.daily-rollup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T01:00:00.000Z"));
    mocks.listRunsAwaitingRollup.mockReset().mockResolvedValue([]);
    mocks.listWorkspacesWithRuns.mockReset().mockResolvedValue([]);
    mocks.rebuildRunTotals.mockReset().mockResolvedValue(RUN_YESTERDAY);
    mocks.rebuildDailyTotals.mockReset().mockResolvedValue([]);
    mocks.warn.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("runs nightly", () => {
    expect(trigger?.cron).toBe("0 1 * * *");
  });

  it("rolls up every sealed run without a current row, then yesterday's workspaces", async () => {
    mocks.listRunsAwaitingRollup.mockResolvedValue(["tse_a", "arun_b"]);
    mocks.listWorkspacesWithRuns.mockResolvedValue([
      { orgId: "org-1", workspaceId: "ws-1" },
    ]);
    const out = await handler!({ step });
    expect(mocks.rebuildRunTotals.mock.calls.map((c) => c[0])).toEqual([
      "tse_a",
      "arun_b",
    ]);
    expect(mocks.listWorkspacesWithRuns).toHaveBeenCalledWith({
      day: "2026-09-14",
    });
    expect(mocks.rebuildDailyTotals.mock.calls.map((c) => c[0])).toEqual([
      { orgId: "org-1", workspaceId: "ws-1", day: "2026-09-14" },
    ]);
    expect(out).toEqual({
      pending: 2,
      rolledUp: 2,
      day: "2026-09-14",
      workspaceDays: 1,
    });
  });

  it("refolds the workspace-day of a run that started before yesterday", async () => {
    mocks.listRunsAwaitingRollup.mockResolvedValue(["tse_old"]);
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-2",
      workspaceId: "ws-2",
      startedAt: new Date("2026-09-13T23:30:00.000Z"),
    });
    const out = await handler!({ step });
    expect(mocks.rebuildDailyTotals.mock.calls.map((c) => c[0])).toEqual([
      { orgId: "org-2", workspaceId: "ws-2", day: "2026-09-13" },
    ]);
    expect(out).toMatchObject({ rolledUp: 1, workspaceDays: 1 });
  });

  it("skips the day row of a run no store has", async () => {
    mocks.listRunsAwaitingRollup.mockResolvedValue(["tse_gone"]);
    mocks.rebuildRunTotals.mockResolvedValue(null);
    const out = await handler!({ step });
    expect(mocks.rebuildDailyTotals).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pending: 1, rolledUp: 0, workspaceDays: 0 });
  });

  it("keeps sweeping when one run's frame read fails", async () => {
    mocks.listRunsAwaitingRollup.mockResolvedValue(["tse_bad", "tse_ok"]);
    mocks.rebuildRunTotals
      .mockRejectedValueOnce(new Error("clickhouse down"))
      .mockResolvedValueOnce(RUN_YESTERDAY);
    const out = await handler!({ step });
    expect(mocks.rebuildRunTotals).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ pending: 2, rolledUp: 1 });
  });
});
