import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  embedText: vi.fn(),
  sessionRun: vi.fn(),
  sessionClose: vi.fn(),
  scopedSession: vi.fn(),
  runInTenantScope: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

// Mock both @oxagen/ontology (for the dynamic import inside step.run("store-embedding"))
// and @oxagen/tenancy.
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

await import("./engram.embed-memory");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_DATA = {
  recordId: "rec-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  kind: "observation",
  body: "Some memory content to embed",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("engramEmbedMemory Inngest handler", () => {
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
    // Default: return a 1536-dimensional embedding
    mocks.embedText.mockResolvedValue(new Array(1536).fill(0.1) as number[]);
  });

  it("happy path: calls embedText then stores embedding and returns correct dimensions", async () => {
    const vector = new Array(768).fill(0.5) as number[];
    mocks.embedText.mockResolvedValue(vector);

    const result = await capturedHandler!({
      event: { data: BASE_DATA },
      step: makeStep(),
    });

    expect(mocks.embedText).toHaveBeenCalledOnce();
    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    expect(result).toEqual({ recordId: "rec-1", dimensions: 768 });
  });

  it("slices body to 2000 chars before calling embedText", async () => {
    const longBody = "y".repeat(3000);

    await capturedHandler!({
      event: { data: { ...BASE_DATA, body: longBody } },
      step: makeStep(),
    });

    const [text] = mocks.embedText.mock.calls[0] as [string, unknown];
    expect(text.length).toBe(2000);
  });

  it("passes telemetry context to embedText with orgId and workspaceId", async () => {
    await capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() });

    const [, opts] = mocks.embedText.mock.calls[0] as [string, { telemetry: Record<string, unknown> }];
    expect(opts.telemetry.orgId).toBe("org-1");
    expect(opts.telemetry.workspaceId).toBe("ws-1");
    expect(opts.telemetry.surface).toBe("agent");
  });

  it("propagates embedText failure (Inngest retries the step)", async () => {
    mocks.embedText.mockRejectedValue(new Error("rate limited"));

    await expect(
      capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() }),
    ).rejects.toThrow("rate limited");

    // store-embedding step should not have been called
    expect(mocks.sessionRun).not.toHaveBeenCalled();
  });

  it("calls session.close in the finally block on success", async () => {
    await capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() });

    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });

  it("propagates store step failure so Inngest can retry", async () => {
    mocks.sessionRun.mockRejectedValue(new Error("Neo4j write failed"));

    await expect(
      capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() }),
    ).rejects.toThrow("Neo4j write failed");
  });

  it("passes recordId and embedding to the store Cypher", async () => {
    const vector = [0.1, 0.2, 0.3];
    mocks.embedText.mockResolvedValue(vector);

    await capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() });

    const [, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.recordId).toBe("rec-1");
    expect(params.embedding).toEqual(vector);
  });

  it("logs info on success with recordId and kind", async () => {
    await capturedHandler!({ event: { data: BASE_DATA }, step: makeStep() });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "rec-1", kind: "observation" }),
      "engram.embed-memory: embedded",
    );
  });
});
