import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  // selectCallCount tracks how many times the count-steps query runs.
  selectCallCount: { value: 0 },
  // countOverride: the single aggregating count query returns this scenario.
  countOverride: { total: 2, completed: 1, failed: 0 } as {
    total: number;
    completed: number;
    failed: number;
  },
  generateObjectFor: vi.fn(),
  insertToolInvocation: vi.fn(),
  inngestCreateFunction: vi.fn(),
  claimExecutionStep: vi.fn(),
  renewExecutionStepLease: vi.fn(),
  startLeaseRenewal: vi.fn(),
}));

const MOCK_OUTPUT = {
  summary: "Tim Cook is the CEO of Apple",
  data: { ceo: "Tim Cook" },
};

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

vi.mock("../lease", () => ({
  claimExecutionStep: mocks.claimExecutionStep,
  renewExecutionStepLease: mocks.renewExecutionStepLease,
  startLeaseRenewal: mocks.startLeaseRenewal,
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture handler.
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

await import("./agent.workflow.task.execute");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

/**
 * A step.run mock that reproduces Inngest's real memoization: once a step id
 * has completed, later calls with that id return the cached result WITHOUT
 * re-invoking the callback. Reusing one instance across two handler
 * invocations simulates Inngest replaying the whole function body — the
 * scenario that used to double-insert the tool_invocations telemetry row
 * because it was emitted as plain code, not inside a memoized step.run.
 */
function makeMemoizingStep() {
  const memo = new Map<string, unknown>();
  return {
    run: async (name: string, fn: () => Promise<unknown>) => {
      if (memo.has(name)) return memo.get(name);
      const result = await fn();
      memo.set(name, result);
      return result;
    },
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
    mocks.claimExecutionStep.mockResolvedValue({
      id: "step-uuid-1",
      attempts: 1,
    });
    mocks.renewExecutionStepLease.mockResolvedValue(undefined);
    mocks.startLeaseRenewal.mockReturnValue(() => {});
  });

  it("skips without executing when the step is not claimable", async () => {
    mocks.claimExecutionStep.mockResolvedValue(null);

    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;

    expect(result.status).toBe("skipped");
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("claims the step (attempts + lease) instead of a blind mark-running", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.claimExecutionStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step-uuid-1", orgId: "org-1" }),
    );
  });

  it("renews the lease around the LLM call and stops the renewal after", async () => {
    const stopRenewal = vi.fn();
    mocks.startLeaseRenewal.mockReturnValue(stopRenewal);

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.startLeaseRenewal).toHaveBeenCalledTimes(1);
    expect(stopRenewal).toHaveBeenCalledTimes(1);
  });

  it("clears the lease on the terminal completed write", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const completedCall = setCalls.find(
      ([arg]) => arg.status === "completed" && "outputPayload" in arg,
    );
    expect(completedCall).toBeTruthy();
    expect(completedCall![0]).toHaveProperty("leaseExpiresAt", null);
  });

  it("marks step running via claim, calls generateObjectFor, marks step completed", async () => {
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
    const args = mocks.generateObjectFor.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.prompt).toContain("Find CEO of Apple");
  });

  it("saves outputPayload on the step row when completed", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const completedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "completed",
    );
    expect(completedCall).toBeTruthy();
    expect(
      (completedCall![0] as Record<string, unknown>).outputPayload,
    ).toEqual(MOCK_OUTPUT);
  });

  it("marks step failed and stores failureReason when generateObjectFor throws", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("LLM error"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("LLM error");

    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const failedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "failed",
    );
    expect(failedCall).toBeTruthy();
    expect((failedCall![0] as Record<string, unknown>).failureReason).toBe(
      "LLM error",
    );
  });

  it("writes a completed tool invocation row to telemetry", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    expect(mocks.insertToolInvocation).toHaveBeenCalled();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.capability_name).toBe("workflow.task.execute");
    expect(telArgs.status).toBe("completed");
    expect(telArgs.org_id).toBe("org-1");
    // Witness for #2615: this producer used to hardcode
    // `execution_step_id: null`. stepId is agent_execution_steps.id — the
    // same value handed to generateObjectFor's telemetry.messageId above,
    // which fills token_usage.execution_step_id for this same step.
    expect(telArgs.execution_step_id).toBe("step-uuid-1");
  });

  it("writes a failed tool invocation row when the step fails", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(new Error("fail"));
    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow();
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.status).toBe("failed");
    expect(telArgs.execution_step_id).toBe("step-uuid-1");
  });

  it("does not double-insert the tool_invocations telemetry row when the run is replayed with memoized steps (Inngest retry simulation)", async () => {
    const step = makeMemoizingStep();

    const first = (await capturedHandler!({
      event: BASE_EVENT,
      step,
    })) as Record<string, unknown>;
    expect(first.status).toBe("completed");

    // Simulate Inngest replaying the whole function body (e.g. after a
    // retry, or a worker restart before the function's return value was
    // acknowledged) by invoking the handler again with the SAME memoized
    // step state — every step id already completed on the first pass short-
    // circuits to its cached result instead of re-running.
    const second = (await capturedHandler!({
      event: BASE_EVENT,
      step,
    })) as Record<string, unknown>;
    expect(second.status).toBe("completed");

    // Exactly one completed tool_invocations row for the single logical
    // task execution — not doubled by the replay.
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.status).toBe("completed");
    // Deterministic invocation_id — not a fresh crypto.randomUUID() per replay.
    expect(telArgs.invocation_id).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it("finalizes execution when all steps are terminal (completed + failed >= total)", async () => {
    // completed=2 out of total=2 → triggers finalize-execution update on agentExecutions
    mocks.countOverride = { total: 2, completed: 2, failed: 0 };

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    // The finalize-execution step sets status on agentExecutions; completedAt will be set too
    const finalUpdate = setCalls.find(
      ([arg]) =>
        (arg as Record<string, unknown>).status === "completed" ||
        (arg as Record<string, unknown>).status === "failed",
    );
    expect(finalUpdate).toBeTruthy();
  });
});
