import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  storeMock: { close: vi.fn() },
  createStore: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/engram", () => ({
  createStore: mocks.createStore,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./engram.consolidation.run");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("engramConsolidationRun Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeMock.close.mockResolvedValue(undefined);
    mocks.createStore.mockReturnValue(mocks.storeMock);
  });

  it("returns zero counts on a normal run", async () => {
    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalFacts: 0, totalBoosted: 0, totalPatterns: 0 });
  });

  it("calls store.close in the finally block after a successful run", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.storeMock.close).toHaveBeenCalledTimes(1);
  });

  it("calls store.close even when step.run throws", async () => {
    const throwingStep: StepCtx = {
      run: async (_name: string, _fn: () => Promise<unknown>) => {
        throw new Error("step failed");
      },
    };

    await expect(capturedHandler!({ step: throwingStep })).rejects.toThrow("step failed");

    expect(mocks.storeMock.close).toHaveBeenCalledTimes(1);
  });

  it("logs completion with the result counts", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      { totalFacts: 0, totalBoosted: 0, totalPatterns: 0 },
      "engram.consolidation.run: completed",
    );
  });

  it("creates a store via createStore on each invocation", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.createStore).toHaveBeenCalledTimes(1);
  });
});
