import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rebuildRunTotals: vi.fn(),
  rebuildDailyTotals: vi.fn(),
  createFunction: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  rebuildRunTotals: mocks.rebuildRunTotals,
  rebuildDailyTotals: mocks.rebuildDailyTotals,
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
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

describe("cost.run-progress", () => {
  beforeEach(() => {
    mocks.rebuildRunTotals.mockReset();
    mocks.rebuildDailyTotals.mockReset().mockResolvedValue([]);
    sendEvent.mockClear();
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
    expect(out).toEqual({ runId: "tse_missing", rolledUp: false });
  });

  it("refuses an event with no run id without a retry (negative)", async () => {
    await expect(handler!({ event: { data: {} }, step })).rejects.toMatchObject(
      { name: "NonRetriableError" },
    );
  });
});
