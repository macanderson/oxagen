import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  insertEvents: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // Per-test canned SELECT results, keyed by a marker in the SQL text.
  expiredRuns: [] as unknown[],
  expiredSteps: [] as unknown[],
  stuckFanouts: [] as unknown[],
  stuckExecutions: [] as unknown[],
  executedSql: [] as string[],
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  }),
}));

vi.mock("@oxagen/telemetry", () => ({
  insertEvents: mocks.insertEvents,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// Re-implement the executor's pure status helper so this test doesn't pull in
// the executor module's full dependency chain (kernel, tenancy, drizzle ops).
vi.mock("./agent.execute-subagent", () => ({
  deriveFanoutStatus: (completed: number, total: number, anyFailed: boolean) =>
    completed === total ? "completed" : anyFailed && completed === 0 ? "failed" : "partial",
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: ReturnType<typeof vi.fn>;
};

type HandlerFn = (ctx: { step: StepCtx; event: { data: unknown } }) => Promise<unknown>;

let sweepHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: HandlerFn) => {
    if (opts.id === "agent.lease-sweep") sweepHandler = handler;
    return [{}];
  },
);

await import("./agent.lease-sweep");

// ── Fake system tx ────────────────────────────────────────────────────────────
function makeFakeTx() {
  return {
    execute: vi.fn().mockImplementation((query: { text: string }) => {
      mocks.executedSql.push(query.text);
      const text = query.text;
      if (text.includes("FROM agent.subagent_runs") && text.includes("SELECT")) {
        return Promise.resolve(mocks.expiredRuns);
      }
      if (text.includes("FROM agent.agent_execution_steps") && text.includes("SELECT")) {
        return Promise.resolve(mocks.expiredSteps);
      }
      if (text.includes("FROM agent.subagent_fanouts f")) {
        return Promise.resolve(mocks.stuckFanouts);
      }
      if (text.includes("FROM agent.agent_executions e")) {
        return Promise.resolve(mocks.stuckExecutions);
      }
      if (text.includes("UPDATE agent.subagent_fanouts") || text.includes("UPDATE agent.agent_executions")) {
        return Promise.resolve([{ id: "finalized" }]);
      }
      return Promise.resolve([]);
    }),
  };
}

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function expiredRun(id: string, attempts: number) {
  return {
    id,
    org_id: "org-1",
    workspace_id: "ws-1",
    fanout_id: "fan-1",
    attempts,
    claimed_by: "dead-worker",
  };
}

function expiredStep(id: string, attempts: number) {
  return {
    id,
    org_id: "org-1",
    workspace_id: "ws-1",
    execution_id: "exec-1",
    step_number: 0,
    input_payload: { title: "t", goal: "find X", outputFormat: "json" },
    attempts,
    claimed_by: "dead-worker",
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("agentLeaseSweep handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expiredRuns = [];
    mocks.expiredSteps = [];
    mocks.stuckFanouts = [];
    mocks.stuckExecutions = [];
    mocks.executedSql.length = 0;
    mocks.insertEvents.mockResolvedValue(undefined);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(makeFakeTx()));
  });

  it("no-ops cleanly on an empty sweep", async () => {
    const step = makeStep();
    const result = (await sweepHandler!({ step, event: { data: {} } })) as Record<string, number>;

    expect(result).toMatchObject({
      runsRequeued: 0,
      runsFailedAtCap: 0,
      stepsRequeued: 0,
      stepsFailedAtCap: 0,
      fanoutsFinalized: 0,
      executionsFinalized: 0,
    });
    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(mocks.insertEvents).not.toHaveBeenCalled();
  });

  it("requeues expired runs below the cap and fails runs at the cap", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1), expiredRun("r-2", 3)];

    const result = (await sweepHandler!({ step: makeStep(), event: { data: {} } })) as Record<string, number>;

    expect(result.runsRequeued).toBe(1);
    expect(result.runsFailedAtCap).toBe(1);
    const requeueSql = mocks.executedSql.find((s) => s.includes("SET status = 'pending'") && s.includes("subagent_runs"));
    const failSql = mocks.executedSql.find((s) => s.includes("lease expired after") && s.includes("subagent_runs"));
    expect(requeueSql).toBeTruthy();
    expect(failSql).toBeTruthy();
  });

  it("re-emits one dispatch event per distinct fanout with requeued children", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 0), expiredRun("r-2", 1)];

    const step = makeStep();
    await sweepHandler!({ step, event: { data: {} } });

    expect(step.sendEvent).toHaveBeenCalledWith("redispatch-fanouts", [
      {
        name: "agent/subagent.dispatch",
        data: { orgId: "org-1", workspaceId: "ws-1", fanoutId: "fan-1" },
      },
    ]);
  });

  it("re-emits workflow task events for requeued steps with goal/outputFormat from input_payload", async () => {
    mocks.expiredSteps = [expiredStep("s-1", 1)];

    const step = makeStep();
    await sweepHandler!({ step, event: { data: {} } });

    expect(step.sendEvent).toHaveBeenCalledWith("redispatch-steps", [
      {
        name: "agent/workflow.task.execute",
        data: {
          orgId: "org-1",
          workspaceId: "ws-1",
          executionId: "exec-1",
          stepId: "s-1",
          taskIndex: 0,
          goal: "find X",
          outputFormat: "json",
        },
      },
    ]);
  });

  it("backstop-finalizes a stuck fanout and emits the completion event", async () => {
    mocks.stuckFanouts = [
      { id: "fan-9", org_id: "org-1", workspace_id: "ws-1", total: 2, completed: 1, failed: 1 },
    ];

    const step = makeStep();
    const result = (await sweepHandler!({ step, event: { data: {} } })) as Record<string, number>;

    expect(result.fanoutsFinalized).toBe(1);
    expect(step.sendEvent).toHaveBeenCalledWith("backstop-fanout-completed", [
      expect.objectContaining({
        name: "agent/subagent.fanout.completed",
        data: expect.objectContaining({ fanoutId: "fan-9", status: "partial" }),
      }),
    ]);
  });

  it("backstop-finalizes a quiescent execution", async () => {
    mocks.stuckExecutions = [{ id: "exec-9", org_id: "org-1", workspace_id: "ws-1", completed: 3 }];

    const result = (await sweepHandler!({ step: makeStep(), event: { data: {} } })) as Record<string, number>;

    expect(result.executionsFinalized).toBe(1);
  });

  it("emits agent.lease.expired for every expired row and agent.task.reclaimed only for requeued rows", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1), expiredRun("r-2", 3)];

    await sweepHandler!({ step: makeStep(), event: { data: {} } });

    expect(mocks.insertEvents).toHaveBeenCalledTimes(1);
    const rows = mocks.insertEvents.mock.calls[0]![0] as Array<{ event_type: string; payload: string }>;
    const expired = rows.filter((r) => r.event_type === "agent.lease.expired");
    const reclaimed = rows.filter((r) => r.event_type === "agent.task.reclaimed");
    expect(expired).toHaveLength(2);
    expect(reclaimed).toHaveLength(1);
    expect(JSON.parse(reclaimed[0]!.payload)).toMatchObject({
      kind: "subagent_run",
      runId: "r-1",
      fanoutId: "fan-1",
      attempts: 1,
      claimedBy: "dead-worker",
    });
  });

  it("swallows insertEvents failure without failing the sweep", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1)];
    mocks.insertEvents.mockRejectedValue(new Error("clickhouse down"));

    const result = (await sweepHandler!({ step: makeStep(), event: { data: {} } })) as Record<string, number>;

    expect(result.runsRequeued).toBe(1);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
