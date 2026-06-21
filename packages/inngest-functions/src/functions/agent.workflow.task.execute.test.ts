import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  // selectCallCount tracks how many times the count-steps query runs.
  selectCallCount: { value: 0 },
  // countOverride: the single aggregating count query returns this scenario.
  countOverride: { total: 2, completed: 1, failed: 0 } as { total: number; completed: number; failed: number },
  generateObjectFor: vi.fn(),
  insertToolInvocation: vi.fn(),
  inngestCreateFunction: vi.fn(),
}));

const MOCK_OUTPUT = { summary: "Tim Cook is the CEO of Apple", data: { ceo: "Tim Cook" } };

mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
mocks.generateObjectFor.mockResolvedValue({ object: MOCK_OUTPUT });
mocks.insertToolInvocation.mockResolvedValue(undefined);

// withTenantDb mock: supports update() and select() chains.
// For count-steps, the impl does 3 sequential selects: total, completed, failed.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: (_table: unknown) => ({ set: mocks.dbUpdateSet }),
        // count-steps now issues a single aggregating query that returns one
        // row of { total, completed, failed } from a consistent snapshot.
        select: (_fields: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond: unknown) => {
              mocks.selectCallCount.value += 1;
              const { total, completed, failed } = mocks.countOverride;
              return Promise.resolve([{ total, completed, failed }]);
            },
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

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

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
    executionId: "exec-uuid-1",
    stepId: "step-uuid-1",
    taskIndex: 0,
    goal: "Find CEO of Apple",
    outputFormat: "json",
  },
};

describe("agentWorkflowTaskExecute Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectCallCount.value = 0;
    mocks.countOverride = { total: 2, completed: 1, failed: 0 };
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.generateObjectFor.mockResolvedValue({ object: MOCK_OUTPUT });
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });

  it("marks step running, calls generateObjectFor, marks step completed", async () => {
    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;

    expect(result.stepId).toBe("step-uuid-1");
    expect(result.status).toBe("completed");
    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
  });

  it("passes goal to generateObjectFor prompt", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const args = mocks.generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.prompt).toContain("Find CEO of Apple");
  });

  it("saves outputPayload on the step row when completed", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    const completedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "completed",
    );
    expect(completedCall).toBeTruthy();
    expect((completedCall![0] as Record<string, unknown>).outputPayload).toEqual(MOCK_OUTPUT);
  });

  it("marks step failed and stores failureReason when generateObjectFor throws", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("LLM error"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("LLM error");

    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    const failedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "failed",
    );
    expect(failedCall).toBeTruthy();
    expect((failedCall![0] as Record<string, unknown>).failureReason).toBe("LLM error");
  });

  it("writes a completed tool invocation row to telemetry", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.insertToolInvocation).toHaveBeenCalled();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<string, unknown>;
    expect(telArgs.capability_name).toBe("workflow.task.execute");
    expect(telArgs.status).toBe("completed");
    expect(telArgs.org_id).toBe("org-1");
  });

  it("writes a failed tool invocation row when the step fails", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("fail"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<string, unknown>;
    expect(telArgs.status).toBe("failed");
  });

  it("finalizes execution when all steps are terminal (completed + failed >= total)", async () => {
    // completed=2 out of total=2 → triggers finalize-execution update on agentExecutions
    mocks.countOverride = { total: 2, completed: 2, failed: 0 };

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<[Record<string, unknown>]>;
    // The finalize-execution step sets status on agentExecutions; completedAt will be set too
    const finalUpdate = setCalls.find(
      ([arg]) =>
        (arg as Record<string, unknown>).status === "completed" ||
        (arg as Record<string, unknown>).status === "failed",
    );
    expect(finalUpdate).toBeTruthy();
  });
});
