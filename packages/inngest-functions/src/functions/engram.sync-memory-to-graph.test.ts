import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  sessionRun: vi.fn(),
  sessionClose: vi.fn(),
  scopedSession: vi.fn(),
  runInTenantScope: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/ontology", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

type HandlerFn = (ctx: { event: { data: unknown }; step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./engram.sync-memory-to-graph");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_DATA = {
  recordId: "rec-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  nodeRef: "entity-ref-1",
  entityRefs: ["kn-1", "kn-2"],
  body: "test memory content",
  kind: "observation",
  salience: 0.7,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("engramSyncMemoryToGraph Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionRun.mockResolvedValue(undefined);
    mocks.sessionClose.mockResolvedValue(undefined);
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  });

  it("happy path: calls session.run with correct params and returns synced:true", async () => {
    const result = await capturedHandler!({
      event: { data: BASE_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({ recordId: "rec-1", synced: true });
    expect(mocks.sessionRun).toHaveBeenCalledTimes(1);
    const [, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.recordId).toBe("rec-1");
    expect(params.nodeRef).toBe("entity-ref-1");
    expect(params.entityRefs).toEqual(["kn-1", "kn-2"]);
    expect(params.kind).toBe("observation");
    expect(params.salience).toBe(0.7);
  });

  it("truncates body to 2000 chars before writing to Neo4j", async () => {
    const longBody = "x".repeat(3000);
    await capturedHandler!({
      event: { data: { ...BASE_DATA, body: longBody } },
      step: makeStep(),
    });

    const [, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect((params.body as string).length).toBe(2000);
  });

  it("passes null for nodeRef when absent in event data", async () => {
    await capturedHandler!({
      event: { data: { ...BASE_DATA, nodeRef: null, entityRefs: null } },
      step: makeStep(),
    });

    const [, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.nodeRef).toBeNull();
    expect(params.entityRefs).toEqual([]);
  });

  it("calls session.close in the finally block on success", async () => {
    await capturedHandler!({
      event: { data: BASE_DATA },
      step: makeStep(),
    });

    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });

  it("calls session.close in the finally block even when session.run throws", async () => {
    mocks.sessionRun.mockRejectedValue(new Error("Neo4j unavailable"));

    await expect(
      capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() }),
    ).rejects.toThrow("Neo4j unavailable");

    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });

  it("logs info on success with recordId and entityRefCount", async () => {
    await capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "rec-1", entityRefCount: 2 }),
      "engram.sync-memory-to-graph: synced",
    );
  });
});
