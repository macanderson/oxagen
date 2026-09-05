import { describe, expect, it, vi, beforeEach } from "vitest";

// A well-formed uuid standing in for backgroundTasks.id (the uuid primary
// key) — deliberately shaped nothing like the "bgt_..." public id, so a test
// asserting against this value cannot pass by accident if the code under
// test regresses to writing the public id again (#2656).
const TASK_UUID = "c9b1b1a4-6b1a-4c1e-9c1a-4b1a6b1a4c1e";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The background-task executor imports are heavy (inngest, database, agent).
// We mock all external seams so the test runs without real infrastructure.
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  /** Mock for the `.returning()` leg of the mark-running UPDATE chain. */
  dbUpdateReturning: vi.fn(),
  dbUpdate: vi.fn(),
  dbInsert: vi.fn(),
  /** Mock for kernel.invoke — replaces the old @oxagen/agent invokeCapability mock. */
  kernelInvoke: vi.fn(),
  insertToolInvocation: vi.fn(),
  inngestCreateFunction: vi.fn(),
  inngestClient: {} as Record<string, unknown>,
}));

// DB UPDATE chain: .update().set().where() — the object .where() returns is
// awaited directly by mark-completed/mark-failed (a plain, non-thenable
// object resolves to itself) and additionally chained with .returning() by
// mark-running to recover the row's real uuid `id` (#2656).
mocks.dbUpdateWhere.mockReturnValue({ returning: mocks.dbUpdateReturning });
mocks.dbUpdateReturning.mockResolvedValue([{ id: TASK_UUID }]);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });

const fakeDb = { update: mocks.dbUpdate };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    // withTenantDb pass-through: invokes the callback with the same fake tx so
    // handler assertions keep working without a real transaction or GUC.
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/tenancy", () => ({
  // runInTenantScope pass-through: executes fn() directly in unit tests so
  // the tenant scope is satisfied without a real ALS entry.
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

// Mock @oxagen/oxagen/kernel's invoke function (OXA-1498: capability calls now
// route through kernel.invoke instead of @oxagen/agent's invokeCapability).
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.kernelInvoke,
}));

// Stub @oxagen/telemetry so insertToolInvocation doesn't need ClickHouse.
mocks.insertToolInvocation.mockResolvedValue(undefined);
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

// Stub @oxagen/oxagen to a no-op (just the side-effect import)
vi.mock("@oxagen/oxagen", () => ({}));

// We don't mock the inngest module itself — the function under test
// uses the inngest singleton exported from ../inngest.js which we stub below.
vi.mock("../inngest", () => ({
  inngest: {
    createFunction: mocks.inngestCreateFunction,
  },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test" }),
}));

// ── Capture the handler fn passed to createFunction ──────────────────────────
// agentBackgroundTaskExecute.ts calls inngest.createFunction(opts, trigger, handlerFn).
// We capture handlerFn so tests can invoke it directly without Inngest.
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
    return {}; // return value is the registered function object
  },
);

// Import triggers createFunction() which populates capturedHandler
await import("./agent.background-task.execute");

// ─────────────────────────────────────────────────────────────────────────────

// Helper: build a deterministic step.run that executes fn synchronously
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
    orgId: "org_1",
    workspaceId: "ws_1",
    taskId: "task_pub_1",
    kind: "export",
    payload: { capability: "recall_memory", q: "test" },
  },
};

describe("agentBackgroundTaskExecute Inngest handler", () => {
  beforeEach(() => {
    mocks.dbUpdate.mockClear();
    mocks.dbUpdateSet.mockClear();
    mocks.dbUpdateWhere.mockClear();
    mocks.dbUpdateReturning.mockClear();
    mocks.kernelInvoke.mockClear();
    mocks.insertToolInvocation.mockClear();
    // Restore DB chain defaults
    mocks.dbUpdateWhere.mockReturnValue({ returning: mocks.dbUpdateReturning });
    mocks.dbUpdateReturning.mockResolvedValue([{ id: TASK_UUID }]);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });

  it("marks the task running, invokes the capability, then marks completed", async () => {
    mocks.kernelInvoke.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    });

    // db().update should have been called at least twice: mark-running + mark-completed
    expect(mocks.dbUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);

    // kernel.invoke called with the capability name from payload (OXA-1498)
    expect(mocks.kernelInvoke).toHaveBeenCalledTimes(1);
    const [capName, _capInput, capCtx] = mocks.kernelInvoke.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(capName).toBe("recall_memory");
    expect(capCtx.orgId).toBe("org_1");
    expect(capCtx.workspaceId).toBe("ws_1");
    expect(capCtx.surface).toBe("runner");

    const r = result as Record<string, unknown>;
    expect(r.taskId).toBe("task_pub_1");
    expect(r.status).toBe("completed");
  });

  it("marks the task failed and rethrows when the capability throws", async () => {
    mocks.kernelInvoke.mockRejectedValueOnce(new Error("capability error"));

    await expect(
      capturedHandler!({
        event: BASE_EVENT,
        step: makeStep(),
      }),
    ).rejects.toThrow("capability error");

    // The mark-failed update must have been called
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const failedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "failed",
    );
    expect(failedCall).toBeTruthy();
    const setArg = failedCall![0] as Record<string, unknown>;
    expect(setArg.failureReason).toBe("capability error");
  });

  it("throws when the payload is missing the capability field", async () => {
    const eventNoCapability = {
      data: {
        orgId: "org_1",
        workspaceId: "ws_1",
        taskId: "task_pub_2",
        kind: "unknown",
        payload: { noCapabilityKey: true },
      },
    };

    await expect(
      capturedHandler!({
        event: eventNoCapability,
        step: makeStep(),
      }),
    ).rejects.toThrow("background task payload missing 'capability'");
  });

  it("uses taskId as requestId in the capability context", async () => {
    mocks.kernelInvoke.mockResolvedValueOnce(null);

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const [, , capCtx] = mocks.kernelInvoke.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(capCtx.requestId).toBe("task_pub_1");
  });

  // Witness for #2615: this producer used to hardcode `execution_step_id:
  // null` on every tool_invocations row, so a row from this executor could
  // never be joined back to the task that produced it. The run's real uuid
  // (backgroundTasks.id, recovered via the mark-running UPDATE's
  // .returning() — #2656) is this run's own identity — the same value
  // CapabilityContext.executionStepId now carries (#2597) — so both the
  // completed and failed telemetry rows must carry it, not null.
  it("gives the capability context the run's executionStepId and writes it through", async () => {
    mocks.kernelInvoke.mockResolvedValueOnce({ ok: true });

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const [, , capCtx] = mocks.kernelInvoke.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(capCtx.executionStepId).toBe(TASK_UUID);

    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.status).toBe("completed");
    expect(telArgs.execution_step_id).toBe(TASK_UUID);
  });

  it("records the run's executionStepId on the failed tool_invocations row too", async () => {
    mocks.kernelInvoke.mockRejectedValueOnce(new Error("capability error"));

    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("capability error");

    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.status).toBe("failed");
    expect(telArgs.execution_step_id).toBe(TASK_UUID);
  });

  // Witness for #2656: message_id/execution_step_id are UUID-typed ClickHouse
  // columns (packages/telemetry/src/schema.sql) and backgroundTasks.publicId
  // ("bgt_...") is a citext string, not a uuid — so this producer's telemetry
  // insert failed on every single background-task run before this fix,
  // silently, because the failure was caught and only logger.warn'd. This
  // asserts the actual shape of the value written, not merely that the row
  // was constructed: a value that happens to equal the taskId string, or any
  // other non-UUID placeholder, must fail this test just as surely as the
  // pre-fix code did.
  it("writes a real UUID — not the bgt_ public id — into message_id and execution_step_id", async () => {
    mocks.kernelInvoke.mockResolvedValueOnce({ ok: true });

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const telArgs = mocks.insertToolInvocation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(telArgs.message_id).toMatch(UUID_RE);
    expect(telArgs.execution_step_id).toMatch(UUID_RE);
    expect(telArgs.message_id).not.toBe(BASE_EVENT.data.taskId);
    expect(telArgs.execution_step_id).not.toBe(BASE_EVENT.data.taskId);
    expect(telArgs.message_id).toBe(TASK_UUID);
    expect(telArgs.execution_step_id).toBe(TASK_UUID);
  });

  // The mark-running UPDATE's WHERE clause targets this exact taskId, so it
  // never matching a row is not this test's normal path — but it is real
  // (e.g. a concurrent hard-delete of the row between start and execute) and
  // there is genuinely no uuid to attribute telemetry to when it happens.
  // Absence must stay absence: the fix must skip the tool_invocations insert
  // rather than substitute a fabricated id (a row keyed by a made-up uuid
  // joins to nothing, or worse, collides with something real).
  it("skips the tool_invocations insert when the background_tasks row has no uuid to give", async () => {
    mocks.dbUpdateReturning.mockResolvedValueOnce([]); // mark-running finds no row
    mocks.kernelInvoke.mockResolvedValueOnce({ ok: true });

    const result = (await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    })) as Record<string, unknown>;

    // The capability still runs and the task still completes — a telemetry
    // gap must never break the user's task.
    expect(result.status).toBe("completed");
    expect(mocks.kernelInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.insertToolInvocation).not.toHaveBeenCalled();
  });

  it("captures non-Error thrown values as string failureReason", async () => {
    // Some code throws strings or numbers; the handler must handle those
    mocks.kernelInvoke.mockRejectedValueOnce("plain string error");

    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toBe("plain string error");

    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const failedCall = setCalls.find(
      ([arg]) => (arg as Record<string, unknown>).status === "failed",
    );
    expect((failedCall![0] as Record<string, unknown>).failureReason).toBe(
      "plain string error",
    );
  });

  it("does not double-insert the tool_invocations telemetry row when the run is replayed with memoized steps (Inngest retry simulation)", async () => {
    mocks.kernelInvoke.mockResolvedValue({ ok: true });

    const step = makeMemoizingStep();

    const first = (await capturedHandler!({
      event: BASE_EVENT,
      step,
    })) as Record<string, unknown>;
    expect(first.status).toBe("completed");

    // Simulate Inngest replaying the whole function body (e.g. after a
    // worker restart before the function's return value was acknowledged)
    // by invoking the handler again with the SAME memoized step state —
    // every step id already completed on the first pass short-circuits to
    // its cached result instead of re-running.
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
});
