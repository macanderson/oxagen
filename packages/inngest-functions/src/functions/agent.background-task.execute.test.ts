import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The background-task executor imports are heavy (inngest, database, agent).
// We mock all external seams so the test runs without real infrastructure.
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  dbInsert: vi.fn(),
  /** Mock for kernel.invoke — replaces the old @oxagen/agent invokeCapability mock. */
  kernelInvoke: vi.fn(),
  insertToolInvocation: vi.fn(),
  inngestCreateFunction: vi.fn(),
  inngestClient: {} as Record<string, unknown>,
}));

// DB UPDATE chain: .update().set().where()
mocks.dbUpdateWhere.mockResolvedValue(undefined);
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
    mocks.kernelInvoke.mockClear();
    mocks.insertToolInvocation.mockClear();
    // Restore DB chain defaults
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
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
