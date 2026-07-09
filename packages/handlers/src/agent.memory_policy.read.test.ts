/**
 * Unit tests for agent.memory.policy.read handler.
 *
 * Strategy: mock withTenantDb so no DB is needed. Tests cover:
 *   - no policy row → returns hardcoded defaults (30, 90, 0.1)
 *   - row exists → returns stored values
 *   - missing workspaceId in ctx → throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { agentMemoryPolicyReadHandler } from "./agent.memory_policy.read";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a tx stub whose query.workspaceMemoryPolicy.findFirst resolves to `row`. */
function makeTx(row: Record<string, unknown> | undefined) {
  return {
    query: {
      workspaceMemoryPolicy: {
        findFirst: vi.fn().mockResolvedValue(row),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("agentMemoryPolicyReadHandler", () => {
  it("returns default policy when no row exists in the DB", async () => {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx(undefined)),
    );

    const result = await agentMemoryPolicyReadHandler({}, TEST_CTX);

    expect(result.halfLifeLowDays).toBe(30);
    expect(result.halfLifeHighDays).toBe(90);
    expect(result.recallThreshold).toBe(0.1);
    expect(result.complianceThreshold).toBe(70);
    expect(result.defaultDecayFloor).toBe(5);
  });

  it("returns stored policy values when a row exists", async () => {
    const storedRow = {
      id: "pol_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 14,
      halfLifeHighDays: 60,
      recallThreshold: 0.2,
      complianceThreshold: 80,
      defaultDecayFloor: 10,
    };

    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx(storedRow)),
    );

    const result = await agentMemoryPolicyReadHandler({}, TEST_CTX);

    expect(result.halfLifeLowDays).toBe(14);
    expect(result.halfLifeHighDays).toBe(60);
    expect(result.recallThreshold).toBe(0.2);
    expect(result.complianceThreshold).toBe(80);
    expect(result.defaultDecayFloor).toBe(10);
  });

  it("falls back recallThreshold to 0.1 when stored row has null recallThreshold", async () => {
    const storedRowNullThreshold = {
      id: "pol_2",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 45,
      halfLifeHighDays: 120,
      recallThreshold: null,
      complianceThreshold: 70,
      defaultDecayFloor: 5,
    };

    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx(storedRowNullThreshold)),
    );

    const result = await agentMemoryPolicyReadHandler({}, TEST_CTX);

    expect(result.halfLifeLowDays).toBe(45);
    expect(result.halfLifeHighDays).toBe(120);
    expect(result.recallThreshold).toBe(0.1);
  });

  it("falls back complianceThreshold/defaultDecayFloor to defaults when stored row has them null", async () => {
    const storedRowNullNewFields = {
      id: "pol_4",
      orgId: "org_1",
      workspaceId: "ws_1",
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
      complianceThreshold: null,
      defaultDecayFloor: null,
    };

    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx(storedRowNullNewFields)),
    );

    const result = await agentMemoryPolicyReadHandler({}, TEST_CTX);

    expect(result.complianceThreshold).toBe(70);
    expect(result.defaultDecayFloor).toBe(5);
  });

  it("throws when workspaceId is missing from ctx", async () => {
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(agentMemoryPolicyReadHandler({}, noWsCtx)).rejects.toThrow(
      "agent.memory.policy.read requires a workspace context",
    );

    // withTenantDb must NOT be called — the guard fires before any DB access.
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("calls withTenantDb exactly once", async () => {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx(undefined)),
    );

    await agentMemoryPolicyReadHandler({}, TEST_CTX);

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
