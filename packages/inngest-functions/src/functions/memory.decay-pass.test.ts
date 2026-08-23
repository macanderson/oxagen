import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  applyDecayToMemory: vi.fn(),
  listDecayableMemories: vi.fn(),
  insertMemoryChange: vi.fn(),
  runInTenantScope: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {
    workspaces: { id: "id" },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    asc: vi.fn((col: unknown) => col),
    gt: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock("@oxagen/agent/memory/neo4j", () => ({
  applyDecayToMemory: mocks.applyDecayToMemory,
  listDecayableMemories: mocks.listDecayableMemories,
}));

vi.mock("@oxagen/telemetry", () => ({
  insertMemoryChange: mocks.insertMemoryChange,
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

type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./memory.decay-pass");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ── DB tx factories ───────────────────────────────────────────────────────────
interface WorkspaceRow {
  id: string;
  orgId: string;
}

function makeSystemTx(workspaceRows: WorkspaceRow[]) {
  const workspacesFindMany = vi.fn().mockResolvedValue(workspaceRows);

  const tx = {
    query: {
      workspaces: { findMany: workspacesFindMany },
    },
  };

  return { tx, workspacesFindMany };
}

// ── decayable-memory fixture builder ─────────────────────────────────────────
interface DecayableMemoryFixture {
  id: string;
  confidenceScore: number;
  halfLifeDays: number;
  decayFloor: number;
  lastEvidenceAt: string | null;
  createdAt: string;
  nodeRef: string;
}

function makeMemory(
  overrides: Partial<DecayableMemoryFixture> = {},
): DecayableMemoryFixture {
  return {
    id: "mem-default",
    confidenceScore: 90,
    halfLifeDays: 90,
    decayFloor: 5,
    lastEvidenceAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    nodeRef: "",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("memoryDecayPass Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyDecayToMemory.mockResolvedValue(undefined);
    mocks.insertMemoryChange.mockResolvedValue(undefined);
    mocks.listDecayableMemories.mockResolvedValue([]);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns totalDecayed:0 when workspace page is empty", async () => {
    const { tx } = makeSystemTx([]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("returns totalDecayed:0 when workspace has no decayable memories", async () => {
    const { tx } = makeSystemTx([{ id: "ws-1", orgId: "org-1" }]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );
    mocks.listDecayableMemories.mockResolvedValue([]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("decays a memory created long ago using its own half-life/decay-floor and returns totalDecayed:1", async () => {
    // Pin time so decay is deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T04:00:00.000Z"));

    const { tx } = makeSystemTx([{ id: "ws-2", orgId: "org-2" }]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    // Created 543 days ago, halfLife=90 days, confidenceScore=90 (0-100 scale),
    // decayFloor=5 → massive decay toward the floor.
    mocks.listDecayableMemories.mockResolvedValue([
      makeMemory({
        id: "mem-2",
        confidenceScore: 90,
        halfLifeDays: 90,
        decayFloor: 5,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastEvidenceAt: null,
        nodeRef: "entity-1",
      }),
    ]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 1 });
    expect(mocks.applyDecayToMemory).toHaveBeenCalledOnce();
    expect(mocks.applyDecayToMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "mem-2" }),
    );

    // new_conf = floor + (conf - floor) * 0.5^(daysSince/halfLife)
    //          = 5 + 85 * 0.5^(543/90) ≈ 6.3
    const { newConfidence } = mocks.applyDecayToMemory.mock.calls[0]![0] as {
      newConfidence: number;
    };
    expect(newConfidence).toBeGreaterThan(5);
    expect(newConfidence).toBeLessThan(10);

    // Telemetry: confidence axis moved, enforcement axis untouched (decay
    // never touches enforcement).
    expect(mocks.insertMemoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        memory_id: "mem-2",
        cause: "decayed",
        confidence_before: 90,
        enforcement_before: 0,
        enforcement_after: 0,
      }),
    );
  });

  it("never decays below the memory's own decay_floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T04:00:00.000Z"));

    const { tx } = makeSystemTx([{ id: "ws-floor", orgId: "org-floor" }]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    // Extremely old memory — decay curve asymptotically approaches the floor
    // but must never go below it.
    mocks.listDecayableMemories.mockResolvedValue([
      makeMemory({
        id: "mem-floor",
        confidenceScore: 40,
        halfLifeDays: 30,
        decayFloor: 12,
        createdAt: "2000-01-01T00:00:00.000Z",
        lastEvidenceAt: null,
      }),
    ]);

    await capturedHandler!({ step: makeStep() });

    const { newConfidence } = mocks.applyDecayToMemory.mock.calls[0]![0] as {
      newConfidence: number;
    };
    expect(newConfidence).toBeGreaterThanOrEqual(12);
  });

  it("skips memory when confidence change is below epsilon (0.001)", async () => {
    vi.useFakeTimers();
    // Very recent — confidence barely changes
    vi.setSystemTime(new Date("2026-06-27T04:00:00.000Z"));

    const { tx } = makeSystemTx([{ id: "ws-3", orgId: "org-3" }]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    // lastEvidenceAt is only 1 minute ago — epsilon check should skip it
    mocks.listDecayableMemories.mockResolvedValue([
      makeMemory({
        id: "mem-3",
        confidenceScore: 90,
        halfLifeDays: 90,
        decayFloor: 5,
        createdAt: "2026-06-27T03:59:00.000Z",
        lastEvidenceAt: "2026-06-27T03:59:00.000Z", // 1 minute ago
      }),
    ]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("logs a warning and continues when workspace processing throws", async () => {
    const { tx } = makeSystemTx([
      { id: "ws-err", orgId: "org-err" },
      { id: "ws-ok", orgId: "org-ok" },
    ]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    // First workspace: listDecayableMemories throws; second: returns empty
    mocks.listDecayableMemories
      .mockRejectedValueOnce(new Error("Neo4j timeout"))
      .mockResolvedValueOnce([]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-err" }),
      expect.any(String),
    );
  });

  it("stops pagination when page is smaller than PAGE_SIZE (200)", async () => {
    // First page: exactly 200 rows (PAGE_SIZE) → would paginate
    // But we return < 200 on the second call to signal end of results.
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `ws-${i}`,
      orgId: `org-${i}`,
    }));
    const page2 = [{ id: "ws-200", orgId: "org-200" }]; // < PAGE_SIZE → stop

    const tx1 = makeSystemTx(page1);
    const tx2 = makeSystemTx(page2);

    let callCount = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const rawTx = callCount === 0 ? tx1.tx : tx2.tx;
        callCount++;
        return fn(rawTx);
      },
    );

    mocks.listDecayableMemories.mockResolvedValue([]);

    // Run — just verify it doesn't infinite-loop and exits with a result
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toBeDefined();
    expect(
      (result as Record<string, unknown>).totalDecayed,
    ).toBeGreaterThanOrEqual(0);
  });
});
