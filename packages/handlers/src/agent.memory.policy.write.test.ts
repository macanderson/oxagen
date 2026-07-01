/**
 * Unit tests for agent.memory.policy.write handler.
 *
 * Strategy: mock withTenantDb so no DB is needed. Tests cover:
 *   - INSERT path when no existing row
 *   - UPDATE path when row already exists
 *   - partial update (only one field supplied)
 *   - missing workspaceId → throws before any DB access
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { agentMemoryPolicyWriteHandler } from "./agent.memory.policy.write";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── tx builders ───────────────────────────────────────────────────────────────

/** Tx stub for the first withTenantDb call (findFirst). */
function makeReadTx(existingRow: Record<string, unknown> | undefined) {
  return {
    query: {
      workspaceMemoryPolicy: {
        findFirst: vi.fn().mockResolvedValue(existingRow),
      },
    },
  };
}

/** Tx stub for the second withTenantDb call (insert). */
function makeInsertTx() {
  return {
    insert: mocks.insertSpy.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

/** Tx stub for the second withTenantDb call (update). */
function makeUpdateTx() {
  return {
    update: mocks.updateSpy.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("agentMemoryPolicyWriteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("INSERTs a new row and returns merged values when no existing policy", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    const result = await agentMemoryPolicyWriteHandler(
      {
        halfLifeLowDays: 14,
        halfLifeHighDays: 60,
        recallThreshold: 0.15,
        complianceThreshold: 80,
        defaultDecayFloor: 10,
      },
      TEST_CTX,
    );

    expect(result.halfLifeLowDays).toBe(14);
    expect(result.halfLifeHighDays).toBe(60);
    expect(result.recallThreshold).toBe(0.15);
    expect(result.complianceThreshold).toBe(80);
    expect(result.defaultDecayFloor).toBe(10);
    // Insert path was taken.
    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.updateSpy).not.toHaveBeenCalled();
  });

  it("UPDATEs the existing row and returns merged values when policy row exists", async () => {
    const existingRow = {
      id: "pol_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await agentMemoryPolicyWriteHandler(
      {
        halfLifeLowDays: 21,
        halfLifeHighDays: 75,
        recallThreshold: 0.05,
        complianceThreshold: 60,
        defaultDecayFloor: 8,
      },
      TEST_CTX,
    );

    expect(result.halfLifeLowDays).toBe(21);
    expect(result.halfLifeHighDays).toBe(75);
    expect(result.recallThreshold).toBe(0.05);
    expect(result.complianceThreshold).toBe(60);
    expect(result.defaultDecayFloor).toBe(8);
    // Update path was taken.
    expect(mocks.updateSpy).toHaveBeenCalledTimes(1);
    expect(mocks.insertSpy).not.toHaveBeenCalled();
  });

  it("preserves existing values for fields not supplied (partial update)", async () => {
    const existingRow = {
      id: "pol_2",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    // Only supply halfLifeLowDays — the rest must fall back to existing.
    const result = await agentMemoryPolicyWriteHandler(
      { halfLifeLowDays: 14 },
      TEST_CTX,
    );

    expect(result.halfLifeLowDays).toBe(14);
    expect(result.halfLifeHighDays).toBe(90); // preserved from existing row
    expect(result.recallThreshold).toBe(0.1); // preserved from existing row
    expect(result.complianceThreshold).toBe(70); // preserved from existing row
    expect(result.defaultDecayFloor).toBe(5); // preserved from existing row
  });

  it("partial update with only recallThreshold preserves the half-life values", async () => {
    const existingRow = {
      id: "pol_3",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 45,
      halfLifeHighDays: 120,
      recallThreshold: 0.2,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await agentMemoryPolicyWriteHandler(
      { recallThreshold: 0.05 },
      TEST_CTX,
    );

    expect(result.halfLifeLowDays).toBe(45);
    expect(result.halfLifeHighDays).toBe(120);
    expect(result.recallThreshold).toBe(0.05);
  });

  it("partial update with only complianceThreshold preserves everything else", async () => {
    const existingRow = {
      id: "pol_5",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await agentMemoryPolicyWriteHandler(
      { complianceThreshold: 85 },
      TEST_CTX,
    );

    expect(result.complianceThreshold).toBe(85);
    expect(result.defaultDecayFloor).toBe(5); // preserved
    expect(result.halfLifeLowDays).toBe(30); // preserved
    expect(result.halfLifeHighDays).toBe(90); // preserved
    expect(result.recallThreshold).toBe(0.1); // preserved
  });

  it("partial update with only defaultDecayFloor preserves everything else", async () => {
    const existingRow = {
      id: "pol_6",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await agentMemoryPolicyWriteHandler(
      { defaultDecayFloor: 15 },
      TEST_CTX,
    );

    expect(result.defaultDecayFloor).toBe(15);
    expect(result.complianceThreshold).toBe(70); // preserved
  });

  it("uses defaults (30, 90, 0.1, 70, 5) for unspecified fields when no existing row", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    // Supply only halfLifeLowDays — the rest should be the code defaults.
    const result = await agentMemoryPolicyWriteHandler(
      { halfLifeLowDays: 7 },
      TEST_CTX,
    );

    expect(result.halfLifeLowDays).toBe(7);
    expect(result.halfLifeHighDays).toBe(90);
    expect(result.recallThreshold).toBe(0.1);
    expect(result.complianceThreshold).toBe(70);
    expect(result.defaultDecayFloor).toBe(5);
  });

  it("throws when workspaceId is missing from ctx", async () => {
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(
      agentMemoryPolicyWriteHandler(
        { halfLifeLowDays: 30, halfLifeHighDays: 90, recallThreshold: 0.1 },
        noWsCtx,
      ),
    ).rejects.toThrow("agent.memory.policy.write requires a workspace context");

    // withTenantDb must NOT be called — the guard fires before any DB access.
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("calls withTenantDb exactly twice (read then write)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    await agentMemoryPolicyWriteHandler(
      { halfLifeLowDays: 30, halfLifeHighDays: 90, recallThreshold: 0.1 },
      TEST_CTX,
    );

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });
});
