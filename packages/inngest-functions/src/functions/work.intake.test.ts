// The work intake jobs (P1-03, #5103). The runner is @oxagen/handlers' own
// (lib/work-intake/runner.ts); here it is a fake, so the test holds the jobs'
// contract: one step per fetched item and per reconcile page, a cursor that
// moves only through the runner's page, triage throttled per workspace, and a
// failure that stays visible on the item.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkIntakeRunner } from "../lib/work-intake-runner";

const mocks = vi.hoisted(() => ({ createFunction: vi.fn() }));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Step = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (name: string, events: unknown) => Promise<unknown>;
};
type Handler = (ctx: { event: { data: Record<string, unknown> }; step: Step }) => Promise<unknown>;
type Registered = {
  config: {
    id?: string;
    retries?: number;
    concurrency?: { key?: string; limit: number };
    throttle?: { limit: number; period: string; key?: string };
    onFailure?: Handler;
  };
  trigger: { event?: string; cron?: string };
  handler: Handler;
};
const registered: Registered[] = [];
mocks.createFunction.mockImplementation((config: Registered["config"], trigger: Registered["trigger"], handler: Handler) => {
  registered.push({ config, trigger, handler });
  return [{}, {}];
});

const { setWorkIntakeRunner, workIntakeRunner } = await import("../lib/work-intake-runner");
const intake = await import("./work.intake");

const job = (id: string): Registered => {
  const found = registered.find((r) => r.config.id === id);
  if (!found) throw new Error(`${id} was not registered`);
  return found;
};

const SCOPE = { org_id: "org-1", workspace_id: "ws-1" };
const stepNames: string[] = [];
const sendEvent = vi.fn(async (_name: string, _events: unknown) => undefined);
const step: Step = {
  run: (name, fn) => {
    stepNames.push(name);
    return fn();
  },
  sendEvent,
};

function fakeRunner(): { [K in keyof WorkIntakeRunner]: ReturnType<typeof vi.fn> } {
  return {
    openDelivery: vi.fn(),
    collectRef: vi.fn(),
    closeDelivery: vi.fn(async () => undefined),
    collectorTargets: vi.fn(),
    reconcilePage: vi.fn(),
    finishReconcile: vi.fn(async () => ({ health: "healthy" })),
    count: vi.fn(),
    triage: vi.fn(),
    recordTriageFailure: vi.fn(async () => undefined),
    prune: vi.fn(),
  };
}

let runner = fakeRunner();

beforeEach(() => {
  runner = fakeRunner();
  setWorkIntakeRunner(runner as unknown as WorkIntakeRunner);
  stepNames.length = 0;
  sendEvent.mockClear();
});

describe("the runner seam", () => {
  it("throws when no runner is installed", () => {
    setWorkIntakeRunner(null);
    expect(() => workIntakeRunner()).toThrow("no intake runner is installed");
  });
});

describe("work/intake-collect", () => {
  it("runs on a stored delivery, at most five per workspace at once", () => {
    const { config, trigger } = job("work/intake-collect");
    expect(trigger.event).toBe("work/event.received");
    expect(config.concurrency).toEqual({ limit: 5, key: "event.data.workspace_id" });
  });

  it("fetches each item in its own step, closes the delivery, and reports each change", async () => {
    runner.openDelivery.mockResolvedValue({ kind: "ready", collectorId: "col-1", refs: [{ providerId: "a" }, { providerId: "b" }] });
    runner.collectRef
      .mockResolvedValueOnce({ publicId: "wi_a", change: "new", digest: "d1" })
      .mockResolvedValueOnce(null);
    const out = await job("work/intake-collect").handler({ event: { data: { ...SCOPE, inbound_event_id: "ie-1" } }, step });

    expect(out).toEqual({ collected: 2, changed: 1 });
    expect(stepNames).toEqual(["open", "collect-0", "collect-1", "close"]);
    expect(runner.collectRef).toHaveBeenNthCalledWith(1, { orgId: "org-1", workspaceId: "ws-1" }, "col-1", { providerId: "a" });
    expect(runner.closeDelivery).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, "ie-1");
    expect(sendEvent).toHaveBeenCalledWith("item-received", [
      {
        name: "work/item.received",
        id: "work-item-wi_a-new-d1",
        data: { org_id: "org-1", workspace_id: "ws-1", item_id: "wi_a", change: "new" },
      },
    ]);
  });

  it("sends nothing when the delivery has nothing to fetch", async () => {
    runner.openDelivery.mockResolvedValue({ kind: "skipped", reason: "paused" });
    const out = await job("work/intake-collect").handler({ event: { data: { ...SCOPE, inbound_event_id: "ie-1" } }, step });
    expect(out).toEqual({ collected: 0, skipped: "paused" });
    expect(runner.closeDelivery).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("sends nothing when no fetched item changed", async () => {
    runner.openDelivery.mockResolvedValue({ kind: "ready", collectorId: "col-1", refs: [{ providerId: "a" }] });
    runner.collectRef.mockResolvedValue(null);
    await job("work/intake-collect").handler({ event: { data: { ...SCOPE, inbound_event_id: "ie-1" } }, step });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("refuses an event with no workspace or no delivery, without a retry", async () => {
    const handler = job("work/intake-collect").handler;
    await expect(handler({ event: { data: { org_id: "org-1", inbound_event_id: "ie-1" } }, step })).rejects.toMatchObject({
      isNonRetriable: true,
      message: "work/intake-collect: the event has no workspace_id, so there is nothing to act on.",
    });
    await expect(handler({ event: { data: { ...SCOPE } }, step })).rejects.toMatchObject({ isNonRetriable: true });
  });
});

describe("the sweeps", () => {
  it("asks for a reconcile of every collector every 15 minutes, deduped per minute", async () => {
    const { trigger, handler } = job("work/intake-sweep");
    expect(trigger.cron).toBe("*/15 * * * *");
    runner.collectorTargets.mockResolvedValue([{ orgId: "org-1", workspaceId: "ws-1", collectorId: "col-1" }]);
    const out = await handler({ event: { data: {} }, step });
    expect(out).toEqual({ requested: 1 });
    const [, events] = sendEvent.mock.calls[0] as [string, Array<{ name: string; id: string; data: unknown }>];
    expect(events[0]?.name).toBe("work/collector.check.requested");
    expect(events[0]?.id).toMatch(/^work-check-reconcile-col-1-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(events[0]?.data).toEqual({ org_id: "org-1", workspace_id: "ws-1", collector_id: "col-1", check: "reconcile", force: false });
  });

  it("asks for a nightly count, and sends nothing when there is no collector", async () => {
    const { trigger, handler } = job("work/intake-count-sweep");
    expect(trigger.cron).toBe("23 3 * * *");
    runner.collectorTargets.mockResolvedValue([]);
    expect(await handler({ event: { data: {} }, step })).toEqual({ requested: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
    runner.collectorTargets.mockResolvedValue([{ orgId: "org-1", workspaceId: "ws-1", collectorId: "col-1" }]);
    await handler({ event: { data: {} }, step });
    const [, events] = sendEvent.mock.calls[0] as [string, Array<{ data: { check: string } }>];
    expect(events[0]?.data.check).toBe("count");
  });
});

describe("work/intake-check", () => {
  const event = (extra: Record<string, unknown> = {}) => ({
    data: { ...SCOPE, collector_id: "col-1", check: "reconcile", force: false, ...extra },
  });

  it("checks one collector at a time", () => {
    expect(job("work/intake-check").config.concurrency).toEqual({ limit: 1, key: "event.data.collector_id" });
  });

  it("reads page after page in their own steps until the provider has no more, then finishes once", async () => {
    runner.reconcilePage
      .mockResolvedValueOnce({ kind: "page", handled: 100, missed: 1, changes: [{ publicId: "wi_a", change: "updated", digest: "d" }], hasMore: true })
      .mockResolvedValueOnce({ kind: "page", handled: 3, missed: 0, changes: [], hasMore: false });
    const out = await job("work/intake-check").handler({ event: event(), step });

    expect(stepNames).toEqual(["page-0", "page-1", "finish"]);
    expect(runner.finishReconcile).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, "col-1", {
      ok: true,
      pages: 2,
      handled: 103,
      missed: 1,
    });
    expect(out).toEqual({ check: "reconcile", ok: true, pages: 2, handled: 103, missed: 1, health: "healthy" });
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  it("records a failed page as a failed reconcile and keeps the pages before it", async () => {
    runner.reconcilePage
      .mockResolvedValueOnce({ kind: "page", handled: 2, missed: 0, changes: [], hasMore: true })
      .mockResolvedValueOnce({ kind: "failed", error: "GitHub GET /user/repos returned HTTP 401." });
    runner.finishReconcile.mockResolvedValue(null);
    const out = await job("work/intake-check").handler({ event: event({ force: true }), step });
    expect(runner.reconcilePage).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" }, "col-1", true);
    expect(out).toMatchObject({ ok: false, pages: 1, error: "GitHub GET /user/repos returned HTTP 401.", health: null });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("stops at the page limit, so the next check resumes from the cursor", async () => {
    runner.reconcilePage.mockResolvedValue({ kind: "page", handled: 1, missed: 0, changes: [], hasMore: true });
    await job("work/intake-check").handler({ event: event(), step });
    expect(runner.reconcilePage).toHaveBeenCalledTimes(intake.RECONCILE_MAX_PAGES);
  });

  it("writes no result row for a collector it skips, and finishes a check skipped after a page", async () => {
    runner.reconcilePage.mockResolvedValueOnce({ kind: "skipped", reason: "paused" });
    expect(await job("work/intake-check").handler({ event: event(), step })).toEqual({ check: "reconcile", skipped: "paused" });
    expect(runner.finishReconcile).not.toHaveBeenCalled();

    runner.reconcilePage
      .mockResolvedValueOnce({ kind: "page", handled: 1, missed: 0, changes: [], hasMore: true })
      .mockResolvedValueOnce({ kind: "skipped", reason: "paused" });
    await job("work/intake-check").handler({ event: event(), step });
    expect(runner.finishReconcile).toHaveBeenCalledTimes(1);
  });

  it("runs the nightly count when the event asks for it", async () => {
    runner.count.mockResolvedValueOnce({ outcome: "count_matched" }).mockResolvedValueOnce(null);
    expect(await job("work/intake-check").handler({ event: event({ check: "count" }), step })).toEqual({
      check: "count",
      outcome: "count_matched",
    });
    expect(await job("work/intake-check").handler({ event: event({ check: "count" }), step })).toEqual({
      check: "count",
      outcome: "skipped",
    });
  });
});

describe("work/intake-triage", () => {
  it("starts at most 60 runs a minute per workspace, and one at a time per item", () => {
    const { config, trigger } = job("work/intake-triage");
    expect(trigger.event).toBe("work/item.received");
    expect(config.throttle).toEqual({ limit: 60, period: "1m", key: "event.data.workspace_id" });
    expect(config.concurrency).toEqual({ limit: 1, key: "event.data.item_id" });
    expect(intake.TRIAGE_RUNS_PER_MINUTE).toBe(60);
  });

  it("triages the item the event names, and says when a person asked for the retry", async () => {
    runner.triage.mockResolvedValue({ kind: "recorded", decision: "tri_1", outcome: "triaged" });
    const handler = job("work/intake-triage").handler;
    expect(await handler({ event: { data: { ...SCOPE, item_id: "wi_a", change: "new" } }, step })).toEqual({
      kind: "recorded",
      decision: "tri_1",
      outcome: "triaged",
    });
    await handler({ event: { data: { ...SCOPE, item_id: "wi_a", change: "retry" } }, step });
    expect(runner.triage).toHaveBeenNthCalledWith(1, { orgId: "org-1", workspaceId: "ws-1" }, "wi_a", false);
    expect(runner.triage).toHaveBeenNthCalledWith(2, { orgId: "org-1", workspaceId: "ws-1" }, "wi_a", true);
  });

  it("records the failure on the item when the retries run out", async () => {
    const onFailure = job("work/intake-triage").config.onFailure as Handler;
    const out = await onFailure({
      event: {
        data: {
          error: { message: "The gateway refused the call" },
          event: { data: { ...SCOPE, item_id: "wi_a", change: "new" } },
        },
      },
      step,
    });
    expect(out).toEqual({ recorded: true });
    expect(runner.recordTriageFailure).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "wi_a",
      "Triage could not run: The gateway refused the call. Retry triage, or set the priority yourself.",
    );
  });

  it("names an unknown error, and records nothing when the failed event names no item", async () => {
    const onFailure = job("work/intake-triage").config.onFailure as Handler;
    await onFailure({ event: { data: { event: { data: { ...SCOPE, item_id: "wi_b" } } } }, step });
    expect(runner.recordTriageFailure).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "wi_b",
      "Triage could not run: an unknown error. Retry triage, or set the priority yourself.",
    );
    expect(await onFailure({ event: { data: { event: { data: { org_id: "org-1" } } } }, step })).toEqual({ recorded: false });
    expect(await onFailure({ event: { data: {} }, step })).toEqual({ recorded: false });
  });
});

describe("work/intake-prune", () => {
  it("prunes once a day", async () => {
    const { trigger, handler } = job("work/intake-prune");
    expect(trigger.cron).toBe("41 4 * * *");
    runner.prune.mockResolvedValue(12);
    expect(await handler({ event: { data: {} }, step })).toEqual({ deleted: 12 });
  });
});
