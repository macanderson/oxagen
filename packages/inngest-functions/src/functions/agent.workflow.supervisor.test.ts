import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbFindFirst: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  dbInsert: vi.fn(),
  dbInsertValues: vi.fn(),
  dbSelect: vi.fn(),
  dbFrom: vi.fn(),
  dbWhere: vi.fn(),
  generateObjectFor: vi.fn(),
  inngestSend: vi.fn(),
  inngestCreateFunction: vi.fn(),
}));

const MOCK_RUN = {
  id: "wfr-uuid-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  goal: "Profile all Fortune 500 CEOs",
  outputFormat: "json",
  status: "planning",
};

const MOCK_PLAN = {
  tasks: [
    { taskIndex: 0, title: "Research CEO #1", goal: "Find CEO of Apple" },
    { taskIndex: 1, title: "Research CEO #2", goal: "Find CEO of Microsoft" },
  ],
};

const MOCK_TASK_ROWS = [
  { id: "wft-uuid-1", taskIndex: 0, goal: "Find CEO of Apple" },
  { id: "wft-uuid-2", taskIndex: 1, goal: "Find CEO of Microsoft" },
];

mocks.dbFindFirst.mockResolvedValue(MOCK_RUN);
mocks.generateObjectFor.mockResolvedValue({ object: MOCK_PLAN });
mocks.dbInsertValues.mockResolvedValue(undefined);
mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues });
mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
mocks.dbWhere.mockResolvedValue(MOCK_TASK_ROWS);
mocks.dbFrom.mockReturnValue({ where: mocks.dbWhere });
mocks.dbSelect.mockReturnValue({ from: mocks.dbFrom });
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      query: {
        workflowRuns: { findFirst: mocks.dbFindFirst },
      },
      update: (_table: unknown) => ({ set: mocks.dbUpdateSet }),
      insert: (_table: unknown) => ({ values: mocks.dbInsertValues }),
      select: () => mocks.dbSelect(),
    };
    return fn(tx);
  },
  schema: {
    workflowRuns: {
      id: "id",
      orgId: "orgId",
      workspaceId: "workspaceId",
      status: "status",
      completedTasks: "completedTasks",
      failedTasks: "failedTasks",
      totalTasks: "totalTasks",
    },
    workflowRunTasks: {
      id: "id",
      workflowRunId: "workflowRunId",
      orgId: "orgId",
      taskIndex: "taskIndex",
      goal: "goal",
    },
  },
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("../inngest", () => ({
  inngest: {
    createFunction: mocks.inngestCreateFunction,
    send: mocks.inngestSend,
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the handler from createFunction.
let capturedHandler: ((ctx: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>) | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./agent.workflow.supervisor");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT = {
  data: {
    orgId: "org-1",
    workspaceId: "ws-1",
    workflowRunId: "wfr-uuid-1",
    maxParallelism: 50,
    maxTasksGuard: 500,
  },
};

describe("agentWorkflowSupervisor Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbFindFirst.mockResolvedValue(MOCK_RUN);
    mocks.generateObjectFor.mockResolvedValue({ object: MOCK_PLAN });
    mocks.dbInsertValues.mockResolvedValue(undefined);
    mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues });
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.dbWhere.mockResolvedValue(MOCK_TASK_ROWS);
    mocks.dbFrom.mockReturnValue({ where: mocks.dbWhere });
    mocks.dbSelect.mockReturnValue({ from: mocks.dbFrom });
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("returns failed when the workflow run is not found", async () => {
    mocks.dbFindFirst.mockResolvedValueOnce(null);
    const result = await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(result).toEqual({ status: "failed", reason: "run not found" });
  });

  it("calls generateObjectFor with the run goal", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const args = mocks.generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.prompt).toContain("Profile all Fortune 500 CEOs");
    expect(args.telemetry).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "runner",
    });
  });

  it("inserts workflow_run_tasks rows for each planned task", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.dbInsertValues).toHaveBeenCalledOnce();
    const insertedTasks = mocks.dbInsertValues.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(insertedTasks).toHaveLength(2);
    expect(insertedTasks[0]).toMatchObject({ taskIndex: 0, goal: "Find CEO of Apple" });
  });

  it("dispatches inngest events for each task", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.inngestSend).toHaveBeenCalled();
    const sendArg = mocks.inngestSend.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(Array.isArray(sendArg)).toBe(true);
    expect(sendArg[0]).toMatchObject({
      name: "agent/workflow.task.execute",
      data: expect.objectContaining({ orgId: "org-1", workflowRunId: "wfr-uuid-1" }),
    });
  });

  it("respects MAX_TASKS_PER_WORKFLOW guard (capped at 500)", async () => {
    const bigPlan = {
      tasks: Array.from({ length: 600 }, (_, i) => ({
        taskIndex: i,
        title: `Task ${i}`,
        goal: `Goal ${i}`,
      })),
    };
    mocks.generateObjectFor.mockResolvedValueOnce({ object: bigPlan });
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const insertedTasks = mocks.dbInsertValues.mock.calls[0]![0] as Array<unknown>;
    expect(insertedTasks.length).toBeLessThanOrEqual(500);
  });

  it("returns tasksDispatched count", async () => {
    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;
    expect(result.tasksDispatched).toBe(2);
  });

  it("updates workflow status to running after planning", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const updateArgs = mocks.dbUpdateSet.mock.calls;
    const runningUpdate = updateArgs.find(
      ([arg]) => (arg as Record<string, unknown>).status === "running",
    );
    expect(runningUpdate).toBeTruthy();
  });
});
