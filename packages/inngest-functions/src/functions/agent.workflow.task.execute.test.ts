import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdateReturning: vi.fn(),
  dbUpdate: vi.fn(),
  generateObjectFor: vi.fn(),
  insertToolInvocation: vi.fn(),
  inngestCreateFunction: vi.fn(),
}));

const MOCK_OUTPUT = { summary: "Tim Cook is the CEO of Apple", data: { ceo: "Tim Cook" } };

mocks.dbUpdateReturning.mockResolvedValue([
  { completedTasks: 1, failedTasks: 0, totalTasks: 2, status: "running" },
]);
mocks.dbUpdateWhere.mockReturnValue({ returning: mocks.dbUpdateReturning });
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
mocks.generateObjectFor.mockResolvedValue({ object: MOCK_OUTPUT });
mocks.insertToolInvocation.mockResolvedValue(undefined);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: (_table: unknown) => ({ set: mocks.dbUpdateSet }),
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

vi.mock("@oxagen/telemetry", () => ({
  insertToolInvocation: mocks.insertToolInvocation,
}));

vi.mock("../inngest", () => ({
  inngest: {
    createFunction: mocks.inngestCreateFunction,
  },
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture handler.
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

await import("./agent.workflow.task.execute");

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
    taskId: "wft-uuid-1",
    taskIndex: 0,
    goal: "Find CEO of Apple",
    outputFormat: "json",
  },
};

describe("agentWorkflowTaskExecute Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbUpdateReturning.mockResolvedValue([
      { completedTasks: 1, failedTasks: 0, totalTasks: 2, status: "running" },
    ]);
    mocks.dbUpdateWhere.mockReturnValue({ returning: mocks.dbUpdateReturning });
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.generateObjectFor.mockResolvedValue({ object: MOCK_OUTPUT });
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });

  it("marks task running, calls generateObjectFor, marks task completed", async () => {
    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;

    expect(result.taskId).toBe("wft-uuid-1");
    expect(result.status).toBe("completed");
    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
  });

  it("passes goal to generateObjectFor prompt", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const args = mocks.generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.prompt).toContain("Find CEO of Apple");
  });

  it("saves output_json on the task row when completed", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    const completedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "completed",
    );
    expect(completedCall).toBeTruthy();
    expect((completedCall![0] as Record<string, unknown>).outputJson).toEqual(MOCK_OUTPUT);
  });

  it("marks task failed and increments failed_tasks when generateObjectFor throws", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("LLM error"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("LLM error");

    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    const failedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "failed",
    );
    expect(failedCall).toBeTruthy();
    expect((failedCall![0] as Record<string, unknown>).error).toBe("LLM error");
  });

  it("writes a completed tool invocation row to telemetry", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.insertToolInvocation).toHaveBeenCalled();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<string, unknown>;
    expect(telArgs.capability_name).toBe("workflow.task.execute");
    expect(telArgs.status).toBe("completed");
    expect(telArgs.org_id).toBe("org-1");
  });

  it("writes a failed tool invocation row when the task fails", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("fail"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<string, unknown>;
    expect(telArgs.status).toBe("failed");
  });

  it("marks workflow completed when all tasks are done", async () => {
    mocks.dbUpdateReturning.mockResolvedValue([
      { completedTasks: 2, failedTasks: 0, totalTasks: 2, status: "running" },
    ]);
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    const finalUpdate = setCalls.find(
      ([arg]) =>
        (arg as Record<string, unknown>).status === "completed" ||
        (arg as Record<string, unknown>).status === "failed",
    );
    expect(finalUpdate).toBeTruthy();
  });
});
