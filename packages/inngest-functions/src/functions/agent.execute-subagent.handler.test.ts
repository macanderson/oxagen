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
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: {
    subagentRuns: { fanoutId: "fanout_id", orgId: "org_id", id: "id" },
    subagentFanouts: { id: "id", orgId: "org_id" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/telemetry", () => ({
  insertToolInvocation: mocks.insertToolInvocation,
  insertEvents: mocks.insertEvents,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

vi.mock("@oxagen/oxagen", () => ({}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (name: string, payload: unknown) => Promise<void>;
};

type HandlerFn = (ctx: { event: { data: unknown }; step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./agent.execute-subagent");

// ── Fake DB tx factory ────────────────────────────────────────────────────────
interface FakeSelectChain {
  from: () => FakeFromChain;
}
interface FakeFromChain {
  where: ReturnType<typeof vi.fn>;
}
interface FakeUpdateChain {
  set: () => FakeSetChain;
}
interface FakeSetChain {
  where: ReturnType<typeof vi.fn>;
}
interface FakeTx {
  select: () => FakeSelectChain;
  update: () => FakeUpdateChain;
}

function makeFakeTx(runs: unknown[] = []): FakeTx {
  const selectWhere = vi.fn().mockResolvedValue(runs);
  const selectFrom: FakeFromChain = { where: selectWhere };
  const select = vi.fn().mockReturnValue({ from: () => selectFrom });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet: FakeSetChain = { where: updateWhere };
  const update = vi.fn().mockReturnValue({ set: () => updateSet });

  return { select, update };
}

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

const BASE_EVENT_DATA = {
  orgId: "org-1",
  workspaceId: "ws-1",
  fanoutId: "fan-1",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("agentExecuteSubagent Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.insertEvents.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({ ok: true });
  });

  function setupTenantDb(runs: unknown[] = []): FakeTx {
    const fakeTx = makeFakeTx(runs);
    mocks.withTenantDb.mockImplementation(async (fn: (tx: FakeTx) => unknown) => fn(fakeTx));
    return fakeTx;
  }

  it("returns depthExceeded:true immediately when depth > MAX_FANOUT_DEPTH without loading children", async () => {
    setupTenantDb([]);

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
    // withTenantDb must NOT have been called (no DB access before depth guard)
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("returns completed:0 and status:completed when runs array is empty", async () => {
    setupTenantDb([]);

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 0, status: "completed" });
  });

  it("returns status:completed when all children succeed", async () => {
    const runs = [
      { id: "r-1", capabilityName: "agent.memory.recall", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
      { id: "r-2", capabilityName: "agent.memory.recall", inputPayload: {}, childMessageId: "msg-2", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke.mockResolvedValue({ ok: true });

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 2, status: "completed" });
  });

  it("returns status:failed when all children fail", async () => {
    const runs = [
      { id: "r-1", capabilityName: "cap-a", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke.mockRejectedValue(new Error("capability error"));

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 0, status: "failed" });
  });

  it("returns status:partial when some children succeed and some fail", async () => {
    const runs = [
      { id: "r-1", capabilityName: "cap-a", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
      { id: "r-2", capabilityName: "cap-b", inputPayload: {}, childMessageId: "msg-2", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("second child failed"));

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 1, status: "partial" });
  });

  it("records child failure via insertToolInvocation with status 'failed'", async () => {
    const runs = [
      { id: "r-1", capabilityName: "cap-a", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke.mockRejectedValue(new Error("cap failed"));

    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

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
    const runs = [
      { id: "r-1", capabilityName: "cap-a", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke.mockResolvedValue({ ok: true });
    mocks.insertToolInvocation.mockRejectedValue(new Error("ClickHouse down"));

    const result = await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 1, status: "completed" });
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("swallows insertEvents failure in emit-completion-telemetry step", async () => {
    setupTenantDb([]);
    mocks.insertEvents.mockRejectedValue(new Error("events down"));

    const result = await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    expect(result).toEqual({ fanoutId: "fan-1", completed: 0, status: "completed" });
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("treats absent depth as 0 (root dispatch — depth guard not triggered)", async () => {
    setupTenantDb([]);

    // No `depth` in event data — should behave as depth=0
    const result = await capturedHandler!({
      event: { data: { orgId: "org-1", workspaceId: "ws-1", fanoutId: "fan-2" } },
      step: makeStep(),
    });

    // depth guard not triggered, runs normally
    expect(result).toEqual({ fanoutId: "fan-2", completed: 0, status: "completed" });
  });

  it("records successful child via insertToolInvocation with status 'completed'", async () => {
    const runs = [
      { id: "r-1", capabilityName: "cap-ok", inputPayload: {}, childMessageId: "msg-1", fanoutId: "fan-1", orgId: "org-1" },
    ];
    setupTenantDb(runs);
    mocks.invoke.mockResolvedValue({ result: "ok" });

    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", capability_name: "cap-ok" }),
    );
  });
});
