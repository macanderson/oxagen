import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  execFindFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          agentExecutions: { findFirst: mocks.execFindFirst },
        },
      }),
  };
});

import { schemaReconcileStatusHandler } from "./schema.reconcile.status";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = { executionId: "aex_xyz" };

describe("schemaReconcileStatusHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects counters from agent_executions state", async () => {
    mocks.execFindFirst.mockResolvedValue({
      status: "running",
      state: {
        totalNodes: 100,
        processedNodes: 50,
        updatedNodes: 30,
        totalRelationships: 20,
        processedRelationships: 10,
        updatedRelationships: 5,
        prunedNodes: 2,
        prunedRelationships: 1,
      },
    });

    const result = await schemaReconcileStatusHandler(BASE_INPUT, CTX);

    expect(result.status).toBe("running");
    expect(result.totalNodes).toBe(100);
    expect(result.processedNodes).toBe(50);
    expect(result.updatedNodes).toBe(30);
    expect(result.totalRelationships).toBe(20);
    expect(result.processedRelationships).toBe(10);
    expect(result.updatedRelationships).toBe(5);
    expect(result.prunedNodes).toBe(2);
    expect(result.prunedRelationships).toBe(1);
  });

  it("throws if execution not found", async () => {
    mocks.execFindFirst.mockResolvedValueOnce(undefined);
    await expect(schemaReconcileStatusHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "schema.reconcile.status: execution not found: aex_xyz",
    );
  });

  it("returns zero counters when prune=false and prunedNodes is absent from state", async () => {
    mocks.execFindFirst.mockResolvedValue({
      status: "completed",
      state: {
        totalNodes: 40,
        processedNodes: 40,
        updatedNodes: 10,
        totalRelationships: 5,
        processedRelationships: 5,
        updatedRelationships: 2,
        // prunedNodes and prunedRelationships intentionally absent → defaults to 0
      },
    });

    const result = await schemaReconcileStatusHandler(BASE_INPUT, CTX);

    expect(result.status).toBe("completed");
    expect(result.prunedNodes).toBe(0);
    expect(result.prunedRelationships).toBe(0);
  });

  it("returns completed status with all counters populated", async () => {
    mocks.execFindFirst.mockResolvedValue({
      status: "completed",
      state: {
        totalNodes: 200,
        processedNodes: 200,
        updatedNodes: 75,
        totalRelationships: 80,
        processedRelationships: 80,
        updatedRelationships: 12,
        prunedNodes: 0,
        prunedRelationships: 0,
      },
    });

    const result = await schemaReconcileStatusHandler(BASE_INPUT, CTX);

    expect(result.status).toBe("completed");
    expect(result.totalNodes).toBe(200);
    expect(result.processedNodes).toBe(200);
    expect(result.updatedNodes).toBe(75);
    expect(result.totalRelationships).toBe(80);
    expect(result.processedRelationships).toBe(80);
    expect(result.updatedRelationships).toBe(12);
    expect(result.prunedNodes).toBe(0);
    expect(result.prunedRelationships).toBe(0);
  });
});
