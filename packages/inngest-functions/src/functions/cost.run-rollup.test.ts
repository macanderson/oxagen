import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rebuildRunTotals: vi.fn(),
  rebuildDailyTotals: vi.fn(),
  createFunction: vi.fn(),
  isInAppRun: vi.fn(),
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
vi.mock("../lib/in-app-run", () => ({ isInAppRun: mocks.isInAppRun }));

type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: (label: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
let handler: Handler | null = null;
let config: { concurrency?: { limit: number; key?: string }[] } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, _trigger: unknown, fn: Handler) => {
    config = opts;
    handler = fn;
    return [{}];
  },
);

await import("./cost.run-rollup");

const sendEvent = vi.fn(async () => {});
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

describe("cost.run-rollup", () => {
  beforeEach(() => {
    mocks.rebuildRunTotals.mockReset();
    mocks.rebuildDailyTotals.mockReset().mockResolvedValue([]);
    mocks.isInAppRun.mockReset().mockResolvedValue(false);
    sendEvent.mockClear();
  });

  it("serialises on the run id", () => {
    expect(config?.concurrency).toEqual([
      { limit: 4 },
      { limit: 1, key: "event.data.runId" },
    ]);
  });

  it("rebuilds the run's row, then the daily groups of the day it started", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-14T23:30:00.000Z"),
      costMicros: 41265n,
      costBasis: "client_attested",
    });
    const out = await handler!({
      event: { data: { runId: "tse_abc" } },
      step,
    });
    expect(mocks.rebuildRunTotals).toHaveBeenCalledWith("tse_abc");
    expect(mocks.rebuildDailyTotals).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      day: "2026-09-14",
    });
    expect(out).toEqual({ runId: "tse_abc", rolledUp: true });
    expect(sendEvent).toHaveBeenCalledWith("request-findings", {
      name: "cost/findings.requested",
      data: { orgId: "org-1", workspaceId: "ws-1" },
    });
    // The fit reading reads the row's tokens, so it is asked for after it.
    expect(sendEvent).toHaveBeenLastCalledWith("request-fit", {
      name: "run/fit.requested",
      data: { orgId: "org-1", workspaceId: "ws-1", runId: "tse_abc" },
    });
    // A Tacho session is never an in-app run, so nothing reads its surface.
    expect(mocks.isInAppRun).not.toHaveBeenCalled();
  });

  // ADR-235, 2026-10-02 amendment. The workspace does not monitor the in-app
  // assistant. Its run still gets both rows, because they count what the
  // organization spent, and it gets no findings pass and no Model fit reading.
  it("writes both rows for an in-app run and requests no findings and no Model fit", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-14T10:00:00.000Z"),
      costMicros: 900n,
      costBasis: "gateway_observed",
    });
    mocks.isInAppRun.mockResolvedValue(true);
    const out = await handler!({
      event: { data: { runId: "arun_assistant" } },
      step,
    });
    expect(mocks.rebuildRunTotals).toHaveBeenCalledWith("arun_assistant");
    expect(mocks.rebuildDailyTotals).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      day: "2026-09-14",
    });
    expect(mocks.isInAppRun).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "arun_assistant",
    );
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ runId: "arun_assistant", rolledUp: true });
  });

  it("requests findings and a Model fit for a ledger run on another surface", async () => {
    mocks.rebuildRunTotals.mockResolvedValue({
      orgId: "org-1",
      workspaceId: "ws-1",
      startedAt: new Date("2026-09-14T10:00:00.000Z"),
      costMicros: 900n,
      costBasis: "gateway_observed",
    });
    const out = await handler!({
      event: { data: { runId: "arun_external" } },
      step,
    });
    expect(mocks.isInAppRun).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "arun_external",
    );
    expect(sendEvent).toHaveBeenCalledWith("request-findings", {
      name: "cost/findings.requested",
      data: { orgId: "org-1", workspaceId: "ws-1" },
    });
    expect(sendEvent).toHaveBeenLastCalledWith("request-fit", {
      name: "run/fit.requested",
      data: { orgId: "org-1", workspaceId: "ws-1", runId: "arun_external" },
    });
    expect(out).toEqual({ runId: "arun_external", rolledUp: true });
  });

  it("drops a run no store has without touching the daily groups", async () => {
    mocks.rebuildRunTotals.mockResolvedValue(null);
    const out = await handler!({
      event: { data: { runId: "tse_missing" } },
      step,
    });
    expect(mocks.rebuildDailyTotals).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ runId: "tse_missing", rolledUp: false });
  });

  it("refuses an event with no run id without a retry", async () => {
    await expect(handler!({ event: { data: {} }, step })).rejects.toMatchObject(
      { name: "NonRetriableError" },
    );
  });

  it("lets a degraded frame store fail the step so Inngest retries", async () => {
    mocks.rebuildRunTotals.mockRejectedValue(new Error("clickhouse down"));
    await expect(
      handler!({ event: { data: { runId: "tse_abc" } }, step }),
    ).rejects.toThrow("clickhouse down");
  });
});
