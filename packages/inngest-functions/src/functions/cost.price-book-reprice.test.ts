import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRunsWithIncompleteCost: vi.fn(),
  rebuildRunTotals: vi.fn(),
  rebuildDailyTotals: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  listRunsWithIncompleteCost: mocks.listRunsWithIncompleteCost,
  rebuildRunTotals: mocks.rebuildRunTotals,
  rebuildDailyTotals: mocks.rebuildDailyTotals,
  utcDay: (at: Date) => at.toISOString().slice(0, 10),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: (label: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
let handler: Handler | null = null;
let config: { concurrency?: { limit: number } } | null = null;
let trigger: { event?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, t: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = t;
    handler = fn;
    return [{}];
  },
);

await import("./cost.price-book-reprice");

const sendEvent = vi.fn(async (_label: string, _event: unknown) => {});
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

const PAGE = 250;
const row = (n: number) => ({
  runId: `tse_${String(n).padStart(4, "0")}`,
  startedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, n)).toISOString(),
});
const RECORD = {
  orgId: "org-1",
  workspaceId: "ws-1",
  startedAt: new Date("2026-09-14T10:00:00.000Z"),
};

describe("cost.price-book-reprice", () => {
  beforeEach(() => {
    mocks.listRunsWithIncompleteCost.mockReset().mockResolvedValue([]);
    mocks.rebuildRunTotals.mockReset().mockResolvedValue(RECORD);
    mocks.rebuildDailyTotals.mockReset().mockResolvedValue([]);
    mocks.warn.mockReset();
    sendEvent.mockClear();
  });

  it("takes the backdated event, one chain at a time", () => {
    expect(trigger?.event).toBe("cost/price-book.backdated");
    expect(config?.concurrency?.limit).toBe(1);
  });

  it("re-rolls a short page and its workspace-days, and stops", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1), row(2)]);
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.listRunsWithIncompleteCost).toHaveBeenCalledWith({
      limit: PAGE,
      after: undefined,
    });
    expect(mocks.rebuildRunTotals.mock.calls.map((c) => c[0])).toEqual([
      "tse_0001",
      "tse_0002",
    ]);
    expect(mocks.rebuildDailyTotals.mock.calls.map((c) => c[0])).toEqual([
      { orgId: "org-1", workspaceId: "ws-1", day: "2026-09-14" },
    ]);
    expect(sendEvent).toHaveBeenCalledOnce();
    expect(sendEvent).toHaveBeenCalledWith("findings-org-1-ws-1", {
      name: "cost/findings.requested",
      data: { orgId: "org-1", workspaceId: "ws-1" },
    });
    expect(out).toEqual({
      pending: 2,
      retried: 0,
      repriced: 2,
      failed: 0,
      dropped: 0,
      carried: 0,
      workspaceDays: 1,
      more: false,
    });
  });

  it("requests findings once per workspace after all daily totals finish", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([
      row(1),
      row(2),
      row(3),
    ]);
    mocks.rebuildRunTotals
      .mockResolvedValueOnce(RECORD)
      .mockResolvedValueOnce({
        ...RECORD,
        startedAt: new Date("2026-09-15T10:00:00Z"),
      })
      .mockResolvedValueOnce({ ...RECORD, workspaceId: "ws-2" });
    const order: string[] = [];
    mocks.rebuildDailyTotals.mockImplementation(async () => {
      order.push("daily");
      return [];
    });
    sendEvent
      .mockImplementationOnce(async () => {
        order.push("findings");
      })
      .mockImplementationOnce(async () => {
        order.push("findings");
      });
    await handler!({ event: { data: {} }, step });
    expect(order).toEqual(["daily", "daily", "daily", "findings", "findings"]);
    expect(sendEvent.mock.calls).toEqual([
      [
        "findings-org-1-ws-1",
        {
          name: "cost/findings.requested",
          data: { orgId: "org-1", workspaceId: "ws-1" },
        },
      ],
      [
        "findings-org-1-ws-2",
        {
          name: "cost/findings.requested",
          data: { orgId: "org-1", workspaceId: "ws-2" },
        },
      ],
    ]);
  });

  it("does not request findings before a failed daily rebuild can retry", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1)]);
    mocks.rebuildDailyTotals.mockRejectedValue(new Error("daily unavailable"));
    await expect(handler!({ event: { data: {} }, step })).rejects.toThrow(
      "daily unavailable",
    );
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("sends itself the last row of a full page as the next cursor", async () => {
    const page = Array.from({ length: PAGE }, (_, i) => row(i));
    mocks.listRunsWithIncompleteCost.mockResolvedValue(page);
    const out = await handler!({ event: { data: {} }, step });
    expect(sendEvent).toHaveBeenCalledWith("next-page", {
      name: "cost/price-book.backdated",
      data: { after: page[PAGE - 1], retry: [] },
    });
    expect(out).toMatchObject({ pending: PAGE, more: true });
  });

  it("reads the page after the cursor the event carries", async () => {
    const after = row(249);
    await handler!({ event: { data: { after } }, step });
    expect(mocks.listRunsWithIncompleteCost).toHaveBeenCalledWith({
      limit: PAGE,
      after,
    });
  });

  it("drains every page of a backlog larger than one page", async () => {
    const backlog = Array.from({ length: PAGE * 2 + 3 }, (_, i) => row(i));
    mocks.listRunsWithIncompleteCost.mockImplementation(
      async (args: { limit: number; after?: { runId: string } }) => {
        const from = args.after
          ? backlog.findIndex((r) => r.runId === args.after!.runId) + 1
          : 0;
        return backlog.slice(from, from + args.limit);
      },
    );
    let data: unknown = {};
    for (let i = 0; i < 10 && data !== null; i += 1) {
      sendEvent.mockClear();
      await handler!({ event: { data }, step });
      const next = sendEvent.mock.calls.find(
        ([label]) => label === "next-page",
      ) as unknown as [string, { data: unknown }] | undefined;
      data = next ? next[1].data : null;
    }
    expect(data).toBeNull();
    expect(mocks.rebuildRunTotals).toHaveBeenCalledTimes(backlog.length);
  });

  it("goes on past a run whose rebuild fails, and carries it to the next invocation", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1), row(2)]);
    mocks.rebuildRunTotals
      .mockRejectedValueOnce(new Error("clickhouse degraded"))
      .mockResolvedValueOnce(RECORD);
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ repriced: 1, failed: 1, carried: 1 });
    // The page was short, so the cursor stays put: the next invocation exists
    // only to rebuild the run this one could not.
    expect(sendEvent).toHaveBeenCalledWith("next-page", {
      name: "cost/price-book.backdated",
      data: {
        after: { runId: "tse_0002", startedAt: row(2).startedAt },
        retry: [{ runId: "tse_0001", attempt: 1 }],
      },
    });
  });

  it("rebuilds the carried runs before the page, and drops the page's limit by as many", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(9)]);
    await handler!({
      event: { data: { retry: [{ runId: "tse_carried", attempt: 1 }] } },
      step,
    });
    expect(mocks.listRunsWithIncompleteCost).toHaveBeenCalledWith({
      limit: PAGE - 1,
      after: undefined,
    });
    expect(mocks.rebuildRunTotals.mock.calls.map((c) => c[0])).toEqual([
      "tse_carried",
      "tse_0009",
    ]);
  });

  it("drops a run that has failed every attempt, and stops the chain with it", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([]);
    mocks.rebuildRunTotals.mockRejectedValue(new Error("clickhouse degraded"));
    const out = await handler!({
      event: { data: { retry: [{ runId: "tse_broken", attempt: 2 }] } },
      step,
    });
    expect(out).toMatchObject({
      repriced: 0,
      failed: 1,
      dropped: 1,
      carried: 0,
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("retries a failing run until the attempt bound, then gives up", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1)]);
    mocks.rebuildRunTotals.mockRejectedValue(new Error("clickhouse degraded"));
    const attempts: number[] = [];
    let data: unknown = {};
    for (let i = 0; i < 6 && data !== null; i += 1) {
      sendEvent.mockClear();
      // Only the first invocation reads the list; the rest carry the run.
      mocks.listRunsWithIncompleteCost.mockResolvedValue(
        i === 0 ? [row(1)] : [],
      );
      await handler!({ event: { data }, step });
      const next = sendEvent.mock.calls.find(
        ([label]) => label === "next-page",
      ) as unknown as
        | [string, { data: { retry: { attempt: number }[] } }]
        | undefined;
      if (!next) {
        data = null;
        continue;
      }
      attempts.push(...next[1].data.retry.map((r) => r.attempt));
      data = next[1].data;
    }
    expect(attempts).toEqual([1, 2]);
    // Three rebuild calls in all: the page plus two carried retries. The
    // third failure drops the run instead of carrying it again.
    expect(mocks.rebuildRunTotals).toHaveBeenCalledTimes(3);
  });

  it("carries the retry list on to the next page when the page is full", async () => {
    const page = Array.from({ length: PAGE - 1 }, (_, i) => row(i));
    mocks.listRunsWithIncompleteCost.mockResolvedValue(page);
    mocks.rebuildRunTotals.mockRejectedValueOnce(new Error("degraded"));
    await handler!({
      event: { data: { retry: [{ runId: "tse_carried", attempt: 1 }] } },
      step,
    });
    expect(sendEvent).toHaveBeenCalledWith("next-page", {
      name: "cost/price-book.backdated",
      data: {
        after: page[PAGE - 2],
        retry: [{ runId: "tse_carried", attempt: 2 }],
      },
    });
  });

  it("refuses a malformed retry list without a retry", async () => {
    await expect(
      handler!({
        event: { data: { retry: [{ runId: "tse_1", attempt: 0 }] } },
        step,
      }),
    ).rejects.toThrow(/malformed retry list/);
    await expect(
      handler!({ event: { data: { retry: "nope" } }, step }),
    ).rejects.toThrow(/malformed retry list/);
    expect(mocks.listRunsWithIncompleteCost).not.toHaveBeenCalled();
  });

  it("lets a failing rebuild throw inside its step, so Inngest retries it", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1)]);
    mocks.rebuildRunTotals.mockRejectedValue(new Error("clickhouse degraded"));
    const thrown: string[] = [];
    const recording = {
      ...step,
      run: async (name: string, fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch (err) {
          thrown.push(name);
          throw err;
        }
      },
    };
    await handler!({ event: { data: {} }, step: recording });
    expect(thrown).toEqual(["run-tse_0001"]);
  });

  it("counts a run no store has as neither repriced nor failed", async () => {
    mocks.listRunsWithIncompleteCost.mockResolvedValue([row(1)]);
    mocks.rebuildRunTotals.mockResolvedValue(null);
    const out = await handler!({ event: { data: {} }, step });
    expect(mocks.rebuildDailyTotals).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pending: 1, repriced: 0, failed: 0 });
  });

  it("refuses a malformed cursor without a retry", async () => {
    await expect(
      handler!({
        event: { data: { after: { runId: "", startedAt: "nope" } } },
        step,
      }),
    ).rejects.toThrow(/malformed cursor/);
    expect(mocks.listRunsWithIncompleteCost).not.toHaveBeenCalled();
  });
});
