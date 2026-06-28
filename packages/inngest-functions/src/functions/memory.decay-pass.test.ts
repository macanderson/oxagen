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
    workspaceMemoryPolicy: { workspaceId: "workspace_id" },
  },
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((col: unknown) => col),
  eq: vi.fn((...args: unknown[]) => args),
  gt: vi.fn((...args: unknown[]) => args),
}));

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
interface WorkspaceRow { id: string; orgId: string }
interface PolicyRow {
  halfLifeLowDays: number | null;
  halfLifeHighDays: number | null;
}

function makeSystemTx(workspaceRows: WorkspaceRow[], policyRow?: PolicyRow) {
  const workspacesFindMany = vi.fn().mockResolvedValue(workspaceRows);
  const policyFindMany = vi.fn().mockResolvedValue(policyRow ? [policyRow] : []);

  const tx = {
    query: {
      workspaces: { findMany: workspacesFindMany },
      workspaceMemoryPolicy: { findMany: policyFindMany },
    },
  };

  return { tx, workspacesFindMany, policyFindMany };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("memoryDecayPass Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyDecayToMemory.mockResolvedValue(undefined);
    mocks.insertMemoryChange.mockResolvedValue(undefined);
    mocks.listDecayableMemories.mockResolvedValue([]);
    mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns totalDecayed:0 when workspace page is empty", async () => {
    const { tx } = makeSystemTx([]);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("returns totalDecayed:0 when workspace has no decayable memories", async () => {
    const { tx } = makeSystemTx([{ id: "ws-1", orgId: "org-1" }]);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));
    mocks.listDecayableMemories.mockResolvedValue([]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("skips critical memories (halfLifeForWeight returns null)", async () => {
    const { tx } = makeSystemTx([{ id: "ws-1", orgId: "org-1" }]);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));
    mocks.listDecayableMemories.mockResolvedValue([
      {
        id: "mem-1",
        weight: "critical",
        confidence: 0.95,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastReinforcedAt: null,
        nodeRef: null,
      },
    ]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 0 });
    expect(mocks.applyDecayToMemory).not.toHaveBeenCalled();
  });

  it("decays a high-weight memory created long ago and returns totalDecayed:1", async () => {
    // Pin time so decay is deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T04:00:00.000Z"));

    const { tx } = makeSystemTx([{ id: "ws-2", orgId: "org-2" }]);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));

    // Created 543 days ago → massive decay for high (halfLife=90 days)
    mocks.listDecayableMemories.mockResolvedValue([
      {
        id: "mem-2",
        weight: "high",
        confidence: 0.9,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastReinforcedAt: null,
        nodeRef: "entity-1",
      },
    ]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalDecayed: 1 });
    expect(mocks.applyDecayToMemory).toHaveBeenCalledOnce();
    expect(mocks.applyDecayToMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "mem-2" }),
    );
  });

  it("skips memory when confidence change is below epsilon (0.001)", async () => {
    vi.useFakeTimers();
    // Very recent — confidence barely changes
    vi.setSystemTime(new Date("2026-06-27T04:00:00.000Z"));

    const { tx } = makeSystemTx([{ id: "ws-3", orgId: "org-3" }]);
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));

    // lastReinforcedAt is only 1 minute ago — epsilon check should skip it
    mocks.listDecayableMemories.mockResolvedValue([
      {
        id: "mem-3",
        weight: "high",
        confidence: 0.9,
        createdAt: "2026-06-27T03:59:00.000Z",
        lastReinforcedAt: "2026-06-27T03:59:00.000Z", // 1 minute ago
        nodeRef: null,
      },
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
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));

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
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `ws-${i}`, orgId: `org-${i}` }));
    const page2 = [{ id: "ws-200", orgId: "org-200" }]; // < PAGE_SIZE → stop

    const tx1 = makeSystemTx(page1);
    const tx2 = makeSystemTx(page2);

    // Each withSystemDb call may be for workspaces OR for policy.
    // We simulate two pagination pages by making the workspaces.findMany
    // return different values on sequential calls via distinct tx objects.
    let callCount = 0;
    mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      // The decay-pass step calls withSystemDb once per page for workspaces
      // and once per workspace for policy. We return page1 for the 1st
      // workspaces query, empty policy for all policy queries, then page2.
      const rawTx = callCount === 0
        ? tx1.tx
        : callCount === 1
          ? makeSystemTx([]).tx     // policy for ws-0 (using defaults)
          : tx2.tx;
      callCount++;
      return fn(rawTx);
    });

    mocks.listDecayableMemories.mockResolvedValue([]);

    // Run — just verify it doesn't infinite-loop and exits with a result
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).totalDecayed).toBeGreaterThanOrEqual(0);
  });
});
