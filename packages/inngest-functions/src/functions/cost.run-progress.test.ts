import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rebuildRunTotals: vi.fn(),
  rebuildDailyTotals: vi.fn(),
  checkNoProgress: vi.fn(),
  createFunction: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  rebuildRunTotals: mocks.rebuildRunTotals,
  rebuildDailyTotals: mocks.rebuildDailyTotals,
  checkNoProgress: mocks.checkNoProgress,
  utcDay: (at: Date) => at.toISOString().slice(0, 10),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: (label: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
type Config = {
  concurrency?: { limit: number; key: string };
  debounce?: { key: string; period: string; timeout: string };
};
let handler: Handler | null = null;
let config: Config | null = null;
let trigger: { event?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: Config, on: { event?: string }, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./cost.run-progress");

const sendEvent = vi.fn(async () => {});
const steps: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
  sendEvent,
};
const NO_LIMIT = { checked: false, loops: 0, newLoops: 0, paused: false };

describe("cost.run-progress", () => {
  beforeEach(() => {
    mocks.rebuildRunTotals.mockReset();
    mocks.rebuildDailyTotals.mockReset().mockResolvedValue([]);
    mocks.checkNoProgress.mockReset().mockResolvedValue(NO_LIMIT);
    sendEvent.mockClear();
    steps.length = 0;
  });

  it("runs on cost/run.progressed", () => {
    expect(trigger).toEqual({ event: "cost/run.progressed" });
  });

  it("debounces per run, and runs at least every two minutes while batches keep coming", () => {
    expect(config?.debounce).toEqual({
      key: "event.data.runId",
      period: "30s",
      timeout: "2m",
    });
  });

  it("serialises on the workspace, whose day rows every run rewrites", () => {
    expect(config?.concurrency).toEqual({
      limit: 1,
      key: "event.data.workspaceId",
    });
  });

  it("rebuilds an open run's row and the day it started on, and asks for no findings", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-14T23:30:00.000Z"),
      sealedAt: null,
      costMicros: 900n,
      costBasis: "client_attested",
    });
    const out = await handler!({ event: { data: { runId: "tse_abc" } }, step });
    expect(mocks.rebuildRunTotals).toHaveBeenCalledWith("tse_abc");
    expect(mocks.rebuildDailyTotals).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      day: "2026-09-14",
    });
    // Findings judge a finished run; the seal's rollup asks for them.
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ runId: "tse_abc", rolledUp: true });
  });

  it("drops a run no store has without touching the daily groups", async () => {
    mocks.rebuildRunTotals.mockResolvedValue(null);
    const out = await handler!({
      event: { data: { runId: "tse_missing" } },
      step,
    });
    expect(mocks.rebuildDailyTotals).not.toHaveBeenCalled();
    expect(mocks.checkNoProgress).not.toHaveBeenCalled();
    expect(out).toEqual({ runId: "tse_missing", rolledUp: false });
  });

  it("checks the run against the no-progress limit after the rollup steps", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-26T10:00:00.000Z"),
      sealedAt: null,
      costMicros: 900n,
      costBasis: "client_attested",
    });
    mocks.checkNoProgress.mockResolvedValue({
      checked: true,
      loops: 1,
      newLoops: 1,
      paused: false,
    });
    const out = await handler!({ event: { data: { runId: "tse_loop" } }, step });
    expect(mocks.checkNoProgress).toHaveBeenCalledWith({
      runId: "tse_loop",
      orgId: "org-1",
      workspaceId: "ws-1",
      sealed: false,
    });
    expect(steps).toEqual(["run-totals", "daily-totals", "no-progress"]);
    expect(out).toEqual({ runId: "tse_loop", rolledUp: true });
  });

  it("tells the check a sealed run is sealed, so an enforced limit does not pause it", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-26T10:00:00.000Z"),
      sealedAt: new Date("2026-09-26T10:30:00.000Z"),
      costMicros: 900n,
      costBasis: "client_attested",
    });
    await handler!({ event: { data: { runId: "tse_sealed" } }, step });
    expect(mocks.checkNoProgress).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "tse_sealed", sealed: true }),
    );
  });

  it("refuses an event with no run id without a retry (negative)", async () => {
    await expect(handler!({ event: { data: {} }, step })).rejects.toMatchObject(
      { name: "NonRetriableError" },
    );
  });
});
