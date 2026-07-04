import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  submitBatch: vi.fn(),
  pollBatch: vi.fn(),
  withTenantDb: vi.fn(),
  scopedSession: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
}));

// Chainable drizzle tx: insert().values() and update().set().where() resolve.
function makeTx() {
  const chain: Record<string, unknown> = {};
  chain.insert = () => chain;
  chain.values = (v: unknown) => {
    mocks.insertValues(v);
    return Promise.resolve(undefined);
  };
  chain.update = () => chain;
  chain.set = (v: unknown) => {
    mocks.updateSet(v);
    return chain;
  };
  chain.where = () => Promise.resolve(undefined);
  return chain;
}

mocks.withTenantDb.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(makeTx()));

vi.mock("@oxagen/ai", () => ({ submitBatch: mocks.submitBatch, pollBatch: mocks.pollBatch }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/ontology/tenant", () => ({ scopedSession: mocks.scopedSession }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: { aiBatchJobs: { providerBatchId: "provider_batch_id" } },
}));
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => ({ eq: a }) }));

import { ingestionGithubInferFeaturesBatch } from "./ingestion.github-infer-features-batch";

const handler = (ingestionGithubInferFeaturesBatch as unknown as {
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
    sleep: vi.fn(async () => undefined),
    sendEvent: vi.fn(),
    waitForEvent: vi.fn(),
  };
}

function fileEvent(fileNaturalKey: string, workspaceId = "ws1") {
  return {
    name: "ingestion/github.infer-features-batch",
    data: {
      fileNaturalKey,
      symbols: [{ kind: "function", name: "charge", startLine: 1, endLine: 9 }],
      orgId: "org1",
      workspaceId,
      connectionId: "conn1",
    },
  };
}

const SUCCEEDED_JSON = '{"features":[{"name":"Billing","description":"d","relatedSymbolNames":["charge"],"confidence":0.9}]}';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(makeTx()));
  mocks.scopedSession.mockReturnValue({ run: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });
  mocks.submitBatch.mockResolvedValue({ batchId: "msgbatch_1", status: "in_progress", requestCount: 2 });
});

describe("ingestion.github-infer-features-batch", () => {
  it("submits one Anthropic batch, tracks it, and writes features for succeeded files", async () => {
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "ended",
      ended: true,
      counts: { succeeded: 2, errored: 0, canceled: 0, expired: 0, processing: 0 },
      results: [
        { customId: "github:conn1:o/r:a.ts", type: "succeeded", text: SUCCEEDED_JSON },
        { customId: "github:conn1:o/r:b.ts", type: "succeeded", text: SUCCEEDED_JSON },
      ],
    });

    const session = { run: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    mocks.scopedSession.mockReturnValue(session);

    const events = [fileEvent("github:conn1:o/r:a.ts"), fileEvent("github:conn1:o/r:b.ts")];
    const res = await handler({ event: events[0], events, step: makeStep() });

    // Single batch submission with one request per file, bare Anthropic model.
    expect(mocks.submitBatch).toHaveBeenCalledTimes(1);
    const submitArg = mocks.submitBatch.mock.calls[0]![0];
    expect(submitArg.model).toBe("claude-haiku-4-5");
    expect(submitArg.requests.map((r: { customId: string }) => r.customId)).toEqual([
      "github:conn1:o/r:a.ts",
      "github:conn1:o/r:b.ts",
    ]);

    // Tracking row inserted with the provider batch id + request count.
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues.mock.calls[0]![0]).toMatchObject({
      providerBatchId: "msgbatch_1",
      requestCount: 2,
      surface: "ingestion",
      model: "claude-haiku-4-5",
      status: "submitted",
    });

    // Feature graph writes ran for the succeeded files (MERGE Feature ... etc).
    expect(session.run).toHaveBeenCalled();
    expect(res).toEqual({ batches: 1, filesWritten: 2 });
  });

  it("groups by workspace and submits one batch per workspace", async () => {
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "ended",
      ended: true,
      counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
      results: [],
    });
    const events = [fileEvent("a.ts", "wsA"), fileEvent("b.ts", "wsB")];
    const res = await handler({ event: events[0], events, step: makeStep() });
    expect(mocks.submitBatch).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ batches: 2 });
  });

  it("leaves the tracking row in_progress when the batch never ends within the poll cap", async () => {
    mocks.pollBatch.mockResolvedValue({
      batchId: "msgbatch_1",
      status: "in_progress",
      ended: false,
      counts: { succeeded: 0, errored: 0, canceled: 0, expired: 0, processing: 1 },
      results: [],
    });
    const events = [fileEvent("a.ts")];
    const step = makeStep();
    const res = await handler({ event: events[0], events, step });
    // status update to in_progress written; no feature writes.
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "in_progress" }));
    expect(res).toEqual({ batches: 1, filesWritten: 0 });
  });

  it("returns early with an empty batch", async () => {
    const res = await handler({ event: fileEvent("x.ts"), events: [], step: makeStep() });
    expect(res).toEqual({ batches: 0, filesWritten: 0 });
    expect(mocks.submitBatch).not.toHaveBeenCalled();
  });
});
