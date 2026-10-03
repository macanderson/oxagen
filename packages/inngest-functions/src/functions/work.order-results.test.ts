// The work order result functions (ADR-251). The runner is @oxagen/handlers'
// own (lib/work-records/results.ts and sweep.ts, installed by its register
// module); here it is a fake, so the test holds the functions' contract: a
// sealed run's event and a run's pull request reach the runner with their
// run and scope, a malformed event is refused without a retry, and the
// hourly sweep visits each workspace in its own step and keeps going past
// one that fails.
import { NonRetriableError } from "@oxagen/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOrderResultsRunner, WorkOrderSweepResult } from "../lib/work-order-results-runner";

const mocks = vi.hoisted(() => ({ createFunction: vi.fn(), info: vi.fn(), warn: vi.fn() }));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("../logger", () => ({ logger: { info: mocks.info, warn: mocks.warn, error: vi.fn() } }));

type Step = { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
type Handler = (ctx: { event: { data: Record<string, unknown> }; step: Step }) => Promise<unknown>;
type Registered = {
  config: { id?: string; retries?: number; concurrency?: unknown };
  trigger: { event?: string; cron?: string };
  handler: Handler;
};
const registered: Registered[] = [];
mocks.createFunction.mockImplementation((config: Registered["config"], trigger: Registered["trigger"], handler: Handler) => {
  registered.push({ config, trigger, handler });
  return [{}];
});

const { setWorkOrderResultsRunner, workOrderResultsRunner } = await import("../lib/work-order-results-runner");
await import("./work.order-results");

const job = (id: string): Registered => {
  const found = registered.find((r) => r.config.id === id);
  if (!found) throw new Error(`${id} was not registered`);
  return found;
};

const ORG = "0192a6f0-0000-7000-8000-00000000000a";
const WS_A = { orgId: ORG, workspaceId: "0192a6f0-0000-7000-8000-0000000000a1" };
const WS_B = { orgId: ORG, workspaceId: "0192a6f0-0000-7000-8000-0000000000b1" };
const RUN = "tse_01k5qk7d0000000000000000";
const ROOT_SESSION = "0192a6f0-0000-7000-8000-0000000000c1";
const PR_URL = "https://github.com/aintel/platform/pull/612";

const stepNames: string[] = [];
const step: Step = {
  run: (name, fn) => {
    stepNames.push(name);
    return fn();
  },
};

function fakeRunner(): { [K in keyof WorkOrderResultsRunner]: ReturnType<typeof vi.fn> } {
  return {
    runEnded: vi.fn(async () => 1),
    pullRequestLinked: vi.fn(async () => 4),
    sweepScopes: vi.fn(async () => []),
    sweep: vi.fn(),
  };
}

function swept(over: Partial<WorkOrderSweepResult> = {}): WorkOrderSweepResult {
  return { sendsEnded: 0, sendsRead: 0, factsRecorded: 0, failed: 0, ...over };
}

let runner = fakeRunner();

beforeEach(() => {
  runner = fakeRunner();
  setWorkOrderResultsRunner(runner as unknown as WorkOrderResultsRunner);
  stepNames.length = 0;
  mocks.info.mockClear();
  mocks.warn.mockClear();
});

describe("the runner seam", () => {
  it("throws when no runner is installed", () => {
    setWorkOrderResultsRunner(null);
    expect(() => workOrderResultsRunner()).toThrow("no work order results runner is installed");
  });

  it("fails a sealed run's event while no runner is installed, so Inngest retries it", async () => {
    setWorkOrderResultsRunner(null);
    const sealed = job("work/order-run-ended").handler({ event: { data: { runId: RUN, ...WS_A } }, step });
    await expect(sealed).rejects.toThrow("no work order results runner is installed");
    await expect(sealed).rejects.not.toBeInstanceOf(NonRetriableError);
  });
});

describe("work/order-run-ended", () => {
  it("runs on every sealed run, one at a time per run", () => {
    const { config, trigger } = job("work/order-run-ended");
    expect(trigger.event).toBe("cost/run.sealed");
    expect(config.retries).toBe(5);
    expect(config.concurrency).toEqual([{ limit: 4 }, { limit: 1, key: "event.data.runId" }]);
  });

  it("records the run's end through the runner with the run and its scope", async () => {
    const out = await job("work/order-run-ended").handler({ event: { data: { runId: RUN, ...WS_A } }, step });
    expect(out).toBe(1);
    expect(stepNames).toEqual(["record-run-ended"]);
    expect(runner.runEnded).toHaveBeenCalledWith({ runId: RUN, orgId: ORG, workspaceId: WS_A.workspaceId });
  });

  it("refuses a malformed event without a retry and records nothing", async () => {
    for (const data of [{ orgId: ORG, workspaceId: WS_A.workspaceId }, { runId: RUN, orgId: "org-1", workspaceId: WS_A.workspaceId }, { runId: "", ...WS_A }]) {
      await expect(job("work/order-run-ended").handler({ event: { data }, step })).rejects.toBeInstanceOf(NonRetriableError);
    }
    expect(runner.runEnded).not.toHaveBeenCalled();
    expect(stepNames).toEqual([]);
  });
});

describe("work/order-pull-request-linked", () => {
  it("runs on every pull request a run names, two at a time per workspace", () => {
    const { config, trigger } = job("work/order-pull-request-linked");
    expect(trigger.event).toBe("run/pull-request.linked");
    expect(config.concurrency).toEqual({ limit: 2, key: "event.data.workspaceId" });
  });

  it("records the pull request through the runner with the root session and its scope", async () => {
    const out = await job("work/order-pull-request-linked").handler({
      event: { data: { ...WS_A, rootSessionUuid: ROOT_SESSION, url: PR_URL } },
      step,
    });
    expect(out).toBe(4);
    expect(stepNames).toEqual(["record-pull-request"]);
    expect(runner.pullRequestLinked).toHaveBeenCalledWith({ ...WS_A, rootSessionUuid: ROOT_SESSION, url: PR_URL });
  });

  it("refuses a malformed event without a retry and records nothing", async () => {
    const linked = job("work/order-pull-request-linked").handler({
      event: { data: { ...WS_A, rootSessionUuid: ROOT_SESSION, url: "not a url" } },
      step,
    });
    await expect(linked).rejects.toBeInstanceOf(NonRetriableError);
    expect(runner.pullRequestLinked).not.toHaveBeenCalled();
  });
});

describe("work/order-results-sweep", () => {
  it("runs hourly at 35 past, one run at a time", () => {
    const { config, trigger } = job("work/order-results-sweep");
    expect(trigger.cron).toBe("35 * * * *");
    expect(trigger.event).toBeUndefined();
    expect(config.concurrency).toEqual({ limit: 1 });
  });

  it("sweeps each workspace in its own step and adds up what each recorded", async () => {
    runner.sweepScopes.mockResolvedValue([WS_A, WS_B]);
    runner.sweep
      .mockResolvedValueOnce(swept({ sendsEnded: 2, sendsRead: 1, factsRecorded: 3 }))
      .mockResolvedValueOnce(swept({ sendsRead: 2, factsRecorded: 1, failed: 1 }));
    const out = await job("work/order-results-sweep").handler({ event: { data: {} }, step });

    expect(stepNames).toEqual(["list-workspaces", `sweep-${WS_A.workspaceId}`, `sweep-${WS_B.workspaceId}`]);
    expect(runner.sweep).toHaveBeenNthCalledWith(1, WS_A);
    expect(runner.sweep).toHaveBeenNthCalledWith(2, WS_B);
    const summary = { workspaces: 2, passed: 2, sendsEnded: 2, sendsRead: 3, factsRecorded: 4, failed: 1 };
    expect(out).toEqual(summary);
    expect(mocks.info).toHaveBeenCalledWith(summary, "work/order-results-sweep complete");
  });

  it("keeps going past a workspace whose pass fails, and logs it", async () => {
    const boom = new Error("database unavailable");
    runner.sweepScopes.mockResolvedValue([WS_A, WS_B]);
    runner.sweep.mockRejectedValueOnce(boom).mockResolvedValueOnce(swept({ sendsEnded: 1 }));
    const out = await job("work/order-results-sweep").handler({ event: { data: {} }, step });

    expect(out).toEqual({ workspaces: 2, passed: 1, sendsEnded: 1, sendsRead: 0, factsRecorded: 0, failed: 0 });
    expect(runner.sweep).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith({ workspaceId: WS_A.workspaceId, err: boom }, "work/order-results-sweep: pass failed");
  });

  it("sweeps nothing when no workspace has a linked send", async () => {
    const out = await job("work/order-results-sweep").handler({ event: { data: {} }, step });
    expect(out).toEqual({ workspaces: 0, passed: 0, sendsEnded: 0, sendsRead: 0, factsRecorded: 0, failed: 0 });
    expect(stepNames).toEqual(["list-workspaces"]);
    expect(runner.sweep).not.toHaveBeenCalled();
  });
});
