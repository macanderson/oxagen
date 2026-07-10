import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  storeMock: { close: vi.fn(), listNamespaces: vi.fn() },
  createStore: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  consolidateWorkspace: vi.fn(),
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

vi.mock("./engram.consolidation.impl", () => ({
  consolidateWorkspace: mocks.consolidateWorkspace,
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

const EMPTY_TOTALS = {
  workspaces: 0,
  newFacts: 0,
  boostedFacts: 0,
  deduped: 0,
  promotedRules: 0,
  reinforced: 0,
  evicted: 0,
  contradictions: 0,
  decayed: 0,
  coldTier: 0,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("engramConsolidationRun Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeMock.close.mockResolvedValue(undefined);
    mocks.storeMock.listNamespaces.mockResolvedValue([]);
    mocks.createStore.mockReturnValue(mocks.storeMock);
  });

  it("returns zero totals when no workspaces have activity", async () => {
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual(EMPTY_TOTALS);
    expect(mocks.consolidateWorkspace).not.toHaveBeenCalled();
  });

  it("consolidates every namespace and aggregates the counts", async () => {
    mocks.storeMock.listNamespaces.mockResolvedValue([
      { org: "o1", workspace: "w1" },
      { org: "o1", workspace: "w2" },
    ]);
    mocks.consolidateWorkspace
      .mockResolvedValueOnce({
        newFacts: 2,
        boostedFacts: 1,
        deduped: 1,
        promotedRules: 1,
        reinforced: 3,
        evicted: 4,
        contradictions: 1,
        decayed: 2,
        coldTier: 1,
      })
      .mockResolvedValueOnce({
        newFacts: 1,
        boostedFacts: 0,
        deduped: 2,
        promotedRules: 0,
        reinforced: 1,
        evicted: 0,
        contradictions: 0,
        decayed: 1,
        coldTier: 0,
      });

    const result = await capturedHandler!({ step: makeStep() });

    expect(mocks.consolidateWorkspace).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      workspaces: 2,
      newFacts: 3,
      boostedFacts: 1,
      deduped: 3,
      promotedRules: 1,
      reinforced: 4,
      evicted: 4,
      contradictions: 1,
      decayed: 3,
      coldTier: 1,
    });
  });

  it("closes the store in the finally block after a successful run", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.storeMock.close).toHaveBeenCalledTimes(1);
  });

  it("closes the store even when a step throws", async () => {
    const throwingStep: StepCtx = {
      run: async () => {
        throw new Error("step failed");
      },
    };
    await expect(capturedHandler!({ step: throwingStep })).rejects.toThrow(
      "step failed",
    );
    expect(mocks.storeMock.close).toHaveBeenCalledTimes(1);
  });

  it("creates a store via createStore on each invocation", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.createStore).toHaveBeenCalledTimes(1);
  });
});
