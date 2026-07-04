import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  pollBatch: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  scopedSession: vi.fn(),
  insertEvents: vi.fn(),
  updateSet: vi.fn(),
}));

// withSystemDb tx: select().from().where().limit() resolves to the queued rows.
function makeSystemTx(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) chain[m] = () => chain;
  chain.limit = () => Promise.resolve(rows);
  return chain;
}
// withTenantDb tx: update().set().where() resolves.
function makeTenantTx() {
  const chain: Record<string, unknown> = {};
  chain.update = () => chain;
  chain.set = (v: unknown) => {
    mocks.updateSet(v);
    return chain;
  };
  chain.where = () => Promise.resolve(undefined);
  return chain;
}

vi.mock("@oxagen/ai", () => ({ pollBatch: mocks.pollBatch }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/ontology/tenant", () => ({ scopedSession: mocks.scopedSession }));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  withTenantDb: mocks.withTenantDb,
  schema: {
    aiBatchJobs: {
      id: "id",
      orgId: "org_id",
      workspaceId: "workspace_id",
      providerBatchId: "provider_batch_id",
      model: "model",
      submittedAt: "submitted_at",
      status: "status",
      deletedAt: "deleted_at",
    },
  },
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mocks.insertEvents }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
}));

import { ingestionBatchReconcile } from "./ai.batch-reconcile";

const handler = (ingestionBatchReconcile as unknown as {
  fn: (args: { event: unknown; events: unknown[]; step: StepMock }) => Promise<unknown>;
}).fn;

interface StepMock {
  run: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  waitForEvent: ReturnType<typeof vi.fn>;
}
function makeStep(): StepMock {
  return {
    run: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    sleep: vi.fn(),
    sendEvent: vi.fn(),
    waitForEvent: vi.fn(),
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "aib_1",
    orgId: "org1",
    workspaceId: "ws1",
    providerBatchId: "msgbatch_1",
    model: "claude-haiku-4-5",
    submittedAt: new Date(),
    ...overrides,
  };
}

const FEATURE_JSON = '{"features":[{"name":"Billing","description":"d","relatedSymbolNames":["charge"],"confidence":0.9}]}';

function queueRows(rows: unknown[]) {
  mocks.withSystemDb.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(makeSystemTx(rows)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(makeTenantTx()));
  mocks.scopedSession.mockReturnValue({ run: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });
  mocks.insertEvents.mockResolvedValue(undefined);
});

describe("ai.batch-reconcile", () => {
  it("no-ops when there are no open batches", async () => {
    queueRows([]);
    const res = await handler({ event: {}, events: [], step: makeStep() });
    expect(res).toEqual({ checked: 0, finalized: 0, failed: 0 });
    expect(mocks.pollBatch).not.toHaveBeenCalled();
  });

  it("skips rows with no provider batch id", async () => {
    queueRows([row({ providerBatchId: null })]);
    const res = await handler({ event: {}, events: [], step: makeStep() });
    expect(res).toEqual({ checked: 0, finalized: 0, failed: 0 });
    expect(mocks.pollBatch).not.toHaveBeenCalled();
  });

  it("finalizes an ended batch: updates the row and writes features", async () => {
    queueRows([row()]);
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "ended",
      ended: true,
      counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
      results: [{ customId: "github:conn9:o/r:a.ts", type: "succeeded", text: FEATURE_JSON }],
    });
    const session = { run: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    mocks.scopedSession.mockReturnValue(session);

    const res = await handler({ event: {}, events: [], step: makeStep() });

    expect(res).toEqual({ checked: 1, finalized: 1, failed: 0 });
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "ended", succeededCount: 1 }));
    // connectionId parsed from the customId → Feature MERGE ran.
    expect(session.run).toHaveBeenCalled();
    const featureMerge = session.run.mock.calls[0]!;
    expect(featureMerge[1]).toMatchObject({ name: "Billing" });
    // reconcile event emitted.
    expect(mocks.insertEvents.mock.calls.at(-1)?.[0][0].event_type).toBe("ai.batch.reconcile.ended");
  });

  it("leaves a recent still-running batch untouched", async () => {
    queueRows([row({ submittedAt: new Date(Date.now() - 60_000) })]);
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "in_progress",
      ended: false,
      counts: { succeeded: 0, errored: 0, canceled: 0, expired: 0, processing: 1 },
      results: [],
    });
    const res = await handler({ event: {}, events: [], step: makeStep() });
    expect(res).toEqual({ checked: 1, finalized: 0, failed: 0 });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("marks a batch failed when it is still open past the dead-batch age", async () => {
    queueRows([row({ submittedAt: new Date(Date.now() - 27 * 3_600_000) })]);
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "in_progress",
      ended: false,
      counts: { succeeded: 0, errored: 0, canceled: 0, expired: 0, processing: 1 },
      results: [],
    });
    const res = await handler({ event: {}, events: [], step: makeStep() });
    expect(res).toEqual({ checked: 1, finalized: 0, failed: 1 });
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(mocks.insertEvents.mock.calls.at(-1)?.[0][0].event_type).toBe("ai.batch.reconcile.failed");
  });
});
