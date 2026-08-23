import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  invoke: vi.fn(),
  insertToolInvocation: vi.fn(),
  insertEvents: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // Claim queue: each call to claimNextSubagentRun shifts one entry; null when
  // drained — mirrors the cooperative-drain contract of the real claim UPDATE.
  claimQueue: [] as unknown[],
  claimNextSubagentRun: vi.fn(),
  renewSubagentRunLease: vi.fn(),
  startLeaseRenewal: vi.fn(),
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withTenantDb: mocks.withTenantDb,
    schema: {
      ...actual.schema,
      subagentRuns: {
        fanoutId: "fanout_id",
        orgId: "org_id",
        id: "id",
        status: "status",
      },
      subagentFanouts: { id: "id", orgId: "org_id", status: "status" },
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
    count: vi.fn((...args: unknown[]) => args),
    inArray: vi.fn((...args: unknown[]) => args),
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
      { raw: (s: string) => s },
    ),
  };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...actual,
    insertToolInvocation: mocks.insertToolInvocation,
    insertEvents: mocks.insertEvents,
  };
});

vi.mock("../lease", () => ({
  claimNextSubagentRun: mocks.claimNextSubagentRun,
  renewSubagentRunLease: mocks.renewSubagentRunLease,
  startLeaseRenewal: mocks.startLeaseRenewal,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

vi.mock("@oxagen/oxagen", () => ({}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: ReturnType<typeof vi.fn>;
  stepNames: string[];
};

type HandlerFn = (ctx: {
  event: { data: unknown };
  step: StepCtx;
  runId?: string;
}) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./agent.execute-subagent");

// ── Fake DB tx ────────────────────────────────────────────────────────────────
interface Scenario {
  counts: { total: number; completed: number; failed: number };
  finalizeRows: unknown[];
}

const scenario: Scenario = {
  counts: { total: 0, completed: 0, failed: 0 },
  finalizeRows: [{ id: "fan-1" }],
};

const updateSet = vi.fn();

function makeFakeTx() {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  updateSet.mockReturnValue({ where: updateWhere });
  return {
    update: () => ({ set: updateSet }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ ...scenario.counts }]),
      }),
    }),
    execute: vi
      .fn()
      .mockImplementation(() => Promise.resolve(scenario.finalizeRows)),
  };
}

function makeStep(): StepCtx {
  const stepNames: string[] = [];
  return {
    run: async (name: string, fn: () => Promise<unknown>) => {
      stepNames.push(name);
      return fn();
    },
    sendEvent: vi.fn().mockResolvedValue(undefined),
    stepNames,
  };
}

function makeClaim(id: string, attempts = 1, capabilityName = "recall_memory") {
  return {
    id,
    childMessageId: `msg-${id}`,
    capabilityName,
    inputPayload: {},
    attempts,
  };
}

const BASE_EVENT_DATA = {
  orgId: "org-1",
  workspaceId: "ws-1",
  fanoutId: "fan-1",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("agentExecuteSubagent Inngest handler (claim-loop)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(makeFakeTx()),
    );
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.insertEvents.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({ ok: true });
    mocks.claimQueue.length = 0;
    mocks.claimNextSubagentRun.mockImplementation(
      async () => mocks.claimQueue.shift() ?? null,
    );
    mocks.renewSubagentRunLease.mockResolvedValue(undefined);
    mocks.startLeaseRenewal.mockReturnValue(() => {});
    scenario.counts = { total: 0, completed: 0, failed: 0 };
    scenario.finalizeRows = [{ id: "fan-1" }];
  });

  it("returns depthExceeded:true immediately when depth > MAX_FANOUT_DEPTH without touching the DB", async () => {
    const result = await capturedHandler!({
      event: { data: { ...BASE_EVENT_DATA, depth: 4 } },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 0,
      status: "failed",
      depthExceeded: true,
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.claimNextSubagentRun).not.toHaveBeenCalled();
  });

  it("finalizes an empty fanout as completed", async () => {
    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 0,
      status: "completed",
    });
  });

  it("drains the claim queue and finalizes completed when all children succeed", async () => {
    mocks.claimQueue.push(makeClaim("r-1"), makeClaim("r-2"));
    scenario.counts = { total: 2, completed: 2, failed: 0 };

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step,
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 2,
      status: "completed",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    // Claim called until drained: 2 rows + 1 null.
    expect(mocks.claimNextSubagentRun).toHaveBeenCalledTimes(3);
    expect(step.sendEvent).toHaveBeenCalledWith(
      "fanout-completed",
      expect.objectContaining({
        name: "agent/subagent.fanout.completed",
        data: expect.objectContaining({
          fanoutId: "fan-1",
          status: "completed",
          totalChildren: 2,
        }),
      }),
    );
  });

  it("passes the worker identity (runId) into the claim", async () => {
    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
      runId: "01RUN",
    });
    expect(mocks.claimNextSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: "01RUN", fanoutId: "fan-1" }),
    );
  });

  it("keys the child step by run id AND attempt so reclaims re-run instead of replaying", async () => {
    mocks.claimQueue.push(makeClaim("r-1", 2));
    scenario.counts = { total: 1, completed: 1, failed: 0 };

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step });

    expect(step.stepNames).toContain("child-r-1-a2");
  });

  it("wraps the invoke in a lease renewal and stops it afterwards", async () => {
    const stopRenewal = vi.fn();
    mocks.startLeaseRenewal.mockReturnValue(stopRenewal);
    mocks.claimQueue.push(makeClaim("r-1"));
    scenario.counts = { total: 1, completed: 1, failed: 0 };

    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(mocks.startLeaseRenewal).toHaveBeenCalledTimes(1);
    expect(stopRenewal).toHaveBeenCalledTimes(1);
  });

  it("stops the lease renewal even when the child invoke throws", async () => {
    const stopRenewal = vi.fn();
    mocks.startLeaseRenewal.mockReturnValue(stopRenewal);
    mocks.claimQueue.push(makeClaim("r-1"));
    mocks.invoke.mockRejectedValue(new Error("boom"));
    scenario.counts = { total: 1, completed: 0, failed: 1 };

    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(stopRenewal).toHaveBeenCalledTimes(1);
  });

  it("returns status:failed when all children fail", async () => {
    mocks.claimQueue.push(makeClaim("r-1", 1, "cap-a"));
    mocks.invoke.mockRejectedValue(new Error("capability error"));
    scenario.counts = { total: 1, completed: 0, failed: 1 };

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 0,
      status: "failed",
    });
  });

  it("returns status:partial when some children succeed and some fail", async () => {
    mocks.claimQueue.push(
      makeClaim("r-1", 1, "cap-a"),
      makeClaim("r-2", 1, "cap-b"),
    );
    mocks.invoke
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("second child failed"));
    scenario.counts = { total: 2, completed: 1, failed: 1 };

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 1,
      status: "partial",
    });
  });

  it("leaves finalize to the last worker when siblings are still owned elsewhere", async () => {
    // This worker drained its queue but another live worker still owns a child.
    mocks.claimQueue.push(makeClaim("r-1"));
    scenario.counts = { total: 3, completed: 1, failed: 1 };

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step,
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 1,
      status: "running",
    });
    expect(step.stepNames).not.toContain("finalize");
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("skips completion telemetry + event when another worker already finalized", async () => {
    mocks.claimQueue.push(makeClaim("r-1"));
    scenario.counts = { total: 1, completed: 1, failed: 0 };
    scenario.finalizeRows = []; // guarded UPDATE matched no row → raced and lost

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step,
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 1,
      status: "completed",
    });
    expect(mocks.insertEvents).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("clears the lease on the terminal write for a completed child", async () => {
    mocks.claimQueue.push(makeClaim("r-1"));
    scenario.counts = { total: 1, completed: 1, failed: 0 };

    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    const setCalls = updateSet.mock.calls as Array<[Record<string, unknown>]>;
    const completedCall = setCalls.find(([arg]) => arg.status === "completed");
    expect(completedCall).toBeTruthy();
    expect(completedCall![0]).toHaveProperty("leaseExpiresAt", null);
  });

  it("records child failure via insertToolInvocation with status 'failed'", async () => {
    mocks.claimQueue.push(makeClaim("r-1", 1, "cap-a"));
    mocks.invoke.mockRejectedValue(new Error("cap failed"));
    scenario.counts = { total: 1, completed: 0, failed: 1 };

    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        capability_name: "cap-a",
        org_id: "org-1",
        workspace_id: "ws-1",
      }),
    );
  });

  it("swallows insertToolInvocation failure without aborting the run", async () => {
    mocks.claimQueue.push(makeClaim("r-1", 1, "cap-a"));
    mocks.insertToolInvocation.mockRejectedValue(new Error("ClickHouse down"));
    scenario.counts = { total: 1, completed: 1, failed: 0 };

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 1,
      status: "completed",
    });
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("swallows insertEvents failure in emit-completion-telemetry step", async () => {
    mocks.insertEvents.mockRejectedValue(new Error("events down"));

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-1",
      completed: 0,
      status: "completed",
    });
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("treats absent depth as 0 (root dispatch — depth guard not triggered)", async () => {
    const result = await capturedHandler!({
      event: {
        data: { orgId: "org-1", workspaceId: "ws-1", fanoutId: "fan-2" },
      },
      step: makeStep(),
    });

    expect(result).toEqual({
      fanoutId: "fan-2",
      completed: 0,
      status: "completed",
    });
  });

  it("records successful child via insertToolInvocation with status 'completed'", async () => {
    mocks.claimQueue.push(makeClaim("r-1", 1, "cap-ok"));
    mocks.invoke.mockResolvedValue({ result: "ok" });
    scenario.counts = { total: 1, completed: 1, failed: 0 };

    await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        capability_name: "cap-ok",
      }),
    );
  });
});
