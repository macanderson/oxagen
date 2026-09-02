import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbFindFirst: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  dbInsertValues: vi.fn(),
  dbSelectFromWhere: vi.fn(),
  generateObjectFor: vi.fn(),
  inngestSend: vi.fn(),
  inngestCreateFunction: vi.fn(),
}));

const MOCK_EXECUTION = {
  id: "exec-uuid-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  status: "planning",
  inputPayload: {
    goal: "Profile all Fortune 500 CEOs",
    outputFormat: "json",
  },
};

const MOCK_PLAN = {
  tasks: [
    { taskIndex: 0, title: "Research CEO #1", goal: "Find CEO of Apple" },
    { taskIndex: 1, title: "Research CEO #2", goal: "Find CEO of Microsoft" },
  ],
};

const MOCK_STEP_ROWS = [
  {
    id: "step-uuid-1",
    stepNumber: 0,
    inputPayload: { goal: "Find CEO of Apple", outputFormat: "json" },
  },
  {
    id: "step-uuid-2",
    stepNumber: 1,
    inputPayload: { goal: "Find CEO of Microsoft", outputFormat: "json" },
  },
];

mocks.dbFindFirst.mockResolvedValue(MOCK_EXECUTION);
mocks.generateObjectFor.mockResolvedValue({ object: MOCK_PLAN });
mocks.dbInsertValues.mockResolvedValue(undefined);
mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
mocks.dbSelectFromWhere.mockResolvedValue(MOCK_STEP_ROWS);
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        query: {
          agentExecutions: { findFirst: mocks.dbFindFirst },
        },
        update: (_table: unknown) => ({ set: mocks.dbUpdateSet }),
        insert: (_table: unknown) => ({ values: mocks.dbInsertValues }),
        select: (_fields: unknown) => ({
          from: (_table: unknown) => ({
            where: mocks.dbSelectFromWhere,
          }),
        }),
      };
      return fn(tx);
    },
  };
});

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

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the handler from createFunction.
let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

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
    executionId: "exec-uuid-1",
    maxParallelism: 50,
    maxTasksGuard: 500,
  },
};

describe("agentWorkflowSupervisor Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbFindFirst.mockResolvedValue(MOCK_EXECUTION);
    mocks.generateObjectFor.mockResolvedValue({ object: MOCK_PLAN });
    mocks.dbInsertValues.mockResolvedValue(undefined);
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.dbSelectFromWhere.mockResolvedValue(MOCK_STEP_ROWS);
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("throws NonRetriableError when the execution is not found", async () => {
    mocks.dbFindFirst.mockResolvedValueOnce(null);
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("execution not found");
  });

  it("calls tx.update to mark execution failed before throwing when execution is not found", async () => {
    mocks.dbFindFirst.mockResolvedValueOnce(null);

    // The withTenantDb mock routes tx.update(table).set(...) through mocks.dbUpdateSet.
    // Configure it to succeed so the not-found path can complete its best-effort update.
    mocks.dbUpdateSet.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("execution not found");

    // The supervisor must have called tx.update(agentExecutions).set({ status: "failed", ... })
    // as part of the "mark-failed-not-found" step before throwing.
    expect(mocks.dbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("thrown error is surfaced as a NonRetriableError (name=NonRetriableError)", async () => {
    mocks.dbFindFirst.mockResolvedValueOnce(null);
    let caughtError: unknown;
    try {
      await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    // wrapHandler translates @oxagen/functions.NonRetriableError (isNonRetriable=true)
    // into Inngest's native NonRetriableError, which has name="NonRetriableError".
    expect((caughtError as Error).name).toBe("NonRetriableError");
  });

  it("calls generateObjectFor with the execution goal", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const args = mocks.generateObjectFor.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.prompt).toContain("Profile all Fortune 500 CEOs");
    expect(args.telemetry).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "runner",
    });
  });

  it("inserts agent_execution_steps rows for each planned task", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.dbInsertValues).toHaveBeenCalledOnce();
    const insertedSteps = mocks.dbInsertValues.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(insertedSteps).toHaveLength(2);
    expect(insertedSteps[0]).toMatchObject({
      stepNumber: 0,
      stepType: "research",
    });
    expect(
      (insertedSteps[0]!.inputPayload as Record<string, unknown>).goal,
    ).toBe("Find CEO of Apple");
  });

  it("dispatches inngest events for each step", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.inngestSend).toHaveBeenCalled();
    const sendArg = mocks.inngestSend.mock.calls[0]?.[0] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(sendArg).toBeDefined();
    expect(sendArg?.[0]).toMatchObject({
      name: "agent/workflow.task.execute",
      data: expect.objectContaining({
        orgId: "org-1",
        executionId: "exec-uuid-1",
      }),
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
    mocks.dbSelectFromWhere.mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, i) => ({
        id: `step-${i}`,
        stepNumber: i,
        inputPayload: { goal: `Goal ${i}`, outputFormat: "json" },
      })),
    );
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const insertedSteps = mocks.dbInsertValues.mock
      .calls[0]![0] as Array<unknown>;
    expect(insertedSteps.length).toBeLessThanOrEqual(500);
  });

  it("returns tasksDispatched count and executionId", async () => {
    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;
    expect(result.tasksDispatched).toBe(2);
    expect(result.executionId).toBe("exec-uuid-1");
  });

  it("updates execution status to running after planning", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const updateArgs = mocks.dbUpdateSet.mock.calls;
    const runningUpdate = updateArgs.find(
      ([arg]) => (arg as Record<string, unknown>).status === "running",
    );
    expect(runningUpdate).toBeTruthy();
  });
});
