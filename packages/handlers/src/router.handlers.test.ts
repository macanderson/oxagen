// router.handlers.test.ts
//
// Unit tests for the four Verified-Outcome Market Router handlers
// (get_routing_policy / set_routing_policy / list_routing_stats /
// preview_routing_decision) and the shared loadEffectiveRoutingPolicy helper.
// @oxagen/database (withTenantDb) and @oxagen/telemetry (readRoutingStats) are
// mocked; @oxagen/agent-engine's pure decision core runs for real, so the tests
// exercise the true resolution / decision logic end to end from the handler.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readRoutingStats: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/telemetry", () => ({
  readRoutingStats: mocks.readRoutingStats,
}));

import { routerPolicyGetHandler } from "./router.policy.get";
import { routerPolicySetHandler } from "./router.policy.set";
import { routerStatsListHandler } from "./router.stats.list";
import { routerDecisionPreviewHandler } from "./router.decision.preview";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

/** A tx whose routingPolicy.findMany resolves the given rows (for loadEffective). */
function findManyTx(rows: unknown[]) {
  return {
    query: { routingPolicy: { findMany: vi.fn().mockResolvedValue(rows) } },
  };
}

function policyRow(over: Record<string, unknown>) {
  return {
    workspaceId: null,
    mode: "off",
    successThreshold: 0.95,
    minSamples: 20,
    windowDays: 30,
    escalateOnRejection: true,
    ...over,
  };
}

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  mocks.readRoutingStats.mockReset();
});

describe("get_routing_policy", () => {
  it("returns the OFF default with source=default when no rows exist", async () => {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx([])),
    );
    const out = await routerPolicyGetHandler({}, CTX);
    expect(out.mode).toBe("off");
    expect(out.source).toBe("default");
    expect(out.successThreshold).toBe(0.95);
  });

  it("resolves the workspace row over the org-default row", async () => {
    const rows = [
      policyRow({ workspaceId: null, mode: "shadow" }),
      policyRow({
        workspaceId: CTX.workspaceId,
        mode: "enforce",
        escalateOnRejection: false,
      }),
    ];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx(rows)),
    );
    const out = await routerPolicyGetHandler({}, CTX);
    expect(out.mode).toBe("enforce");
    expect(out.source).toBe("workspace");
    expect(out.escalateOnRejection).toBe(false);
  });

  it("uses the org-default row when the workspace has none", async () => {
    const rows = [
      policyRow({ workspaceId: null, mode: "shadow", minSamples: 15 }),
    ];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx(rows)),
    );
    const out = await routerPolicyGetHandler({}, CTX);
    expect(out.mode).toBe("shadow");
    expect(out.source).toBe("org");
    expect(out.minSamples).toBe(15);
  });
});

describe("set_routing_policy", () => {
  function upsertTx(existing: unknown) {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    return {
      query: {
        routingPolicy: { findFirst: vi.fn().mockResolvedValue(existing) },
      },
      insert,
      update,
      _captured: { values, insert, update, set },
    };
  }

  it("inserts a new workspace policy when none exists", async () => {
    const tx = upsertTx(undefined);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    const out = await routerPolicySetHandler(
      { scope: "workspace", mode: "enforce" },
      CTX,
    );
    expect(out).toMatchObject({
      scope: "workspace",
      mode: "enforce",
      successThreshold: 0.95,
      minSamples: 20,
      windowDays: 30,
      escalateOnRejection: true,
    });
    expect(tx._captured.insert).toHaveBeenCalledTimes(1);
    expect(tx._captured.values).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        mode: "enforce",
      }),
    );
  });

  it("merges partial fields over an existing row and updates", async () => {
    const existing = policyRow({
      id: "rp_1",
      mode: "shadow",
      successThreshold: 0.9,
      minSamples: 10,
    });
    const tx = upsertTx(existing);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    // scope omitted ⇒ defaults to "workspace"; only mode changes.
    const out = await routerPolicySetHandler({ mode: "enforce" }, CTX);
    expect(out.mode).toBe("enforce");
    expect(out.successThreshold).toBe(0.9); // preserved from existing
    expect(out.minSamples).toBe(10);
    expect(tx._captured.update).toHaveBeenCalledTimes(1);
  });

  it("writes the org-level row (workspace_id null) for scope=org", async () => {
    const tx = upsertTx(undefined);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    const out = await routerPolicySetHandler(
      { scope: "org", mode: "shadow" },
      CTX,
    );
    expect(out.scope).toBe("org");
    expect(tx._captured.values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null, mode: "shadow" }),
    );
  });
});

describe("list_routing_stats", () => {
  it("reads stats with the effective window/minSamples and derives the per-class summary", async () => {
    // Effective policy: enforce, 95% bar, 20 samples, 30d window.
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        findManyTx([
          policyRow({ workspaceId: CTX.workspaceId, mode: "enforce" }),
        ]),
      ),
    );
    mocks.readRoutingStats.mockResolvedValue([
      {
        taskClass: "auth/single",
        model: "haiku",
        tier: "fast",
        samples: 100,
        verifiedCount: 60,
        verifiedRate: 0.6,
        avgCostUsdMicros: 500,
        avgLatencyMs: 1000,
        lastSeen: "x",
      },
      {
        taskClass: "auth/single",
        model: "sonnet",
        tier: "balanced",
        samples: 100,
        verifiedCount: 97,
        verifiedRate: 0.97,
        avgCostUsdMicros: 3000,
        avgLatencyMs: 2000,
        lastSeen: "x",
      },
    ]);
    const out = await routerStatsListHandler({}, CTX);
    expect(mocks.readRoutingStats).toHaveBeenCalledWith({
      taskClass: undefined,
      windowDays: 30,
      minSamples: 20,
    });
    expect(out.rows).toHaveLength(2);
    expect(out.window).toEqual({
      windowDays: 30,
      minSamples: 20,
      successThreshold: 0.95,
    });
    const auth = out.summary.find((s) => s.taskClass === "auth/single")!;
    expect(auth.cheapestEligibleModel).toBe("sonnet"); // haiku fails the 95% bar
    expect(auth.eligibleCount).toBe(1);
  });

  it("honors caller-supplied window/minSamples/taskClass overrides", async () => {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx([])),
    );
    mocks.readRoutingStats.mockResolvedValue([]);
    await routerStatsListHandler(
      { taskClass: "billing/multi", windowDays: 7, minSamples: 5 },
      CTX,
    );
    expect(mocks.readRoutingStats).toHaveBeenCalledWith({
      taskClass: "billing/multi",
      windowDays: 7,
      minSamples: 5,
    });
  });
});

describe("preview_routing_decision", () => {
  it("derives the task class, reads stats, and returns the market decision", async () => {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        findManyTx([
          policyRow({ workspaceId: CTX.workspaceId, mode: "enforce" }),
        ]),
      ),
    );
    mocks.readRoutingStats.mockResolvedValue([
      {
        taskClass: "design/single",
        model: "haiku",
        tier: "fast",
        samples: 100,
        verifiedCount: 96,
        verifiedRate: 0.96,
        avgCostUsdMicros: 500,
        avgLatencyMs: 1000,
        lastSeen: "x",
      },
    ]);
    const out = await routerDecisionPreviewHandler(
      { prompt: "debug the sort" },
      CTX,
    );
    expect(out.taskClass).toBe("design/single");
    expect(out.source).toBe("market");
    expect(out.model).toBe("haiku");
    expect(out.candidates).toHaveLength(1);
    expect(out.policySnapshot.mode).toBe("enforce");
  });

  it("falls back to the deterministic router when no model clears the bar", async () => {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx([])),
    );
    mocks.readRoutingStats.mockResolvedValue([]);
    const out = await routerDecisionPreviewHandler(
      { prompt: "fix the oauth login session bug" },
      CTX,
    );
    expect(out.taskClass).toBe("auth/single");
    expect(out.source).toBe("deterministic-fallback");
    expect(out.tier).toBe("precise"); // auth is a precise-only domain
  });

  it("respects an explicit taskClass override and policy overrides", async () => {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(findManyTx([])),
    );
    mocks.readRoutingStats.mockResolvedValue([]);
    const out = await routerDecisionPreviewHandler(
      { prompt: "anything", taskClass: "custom/class", successThreshold: 0.5 },
      CTX,
    );
    expect(out.taskClass).toBe("custom/class");
    expect(out.policySnapshot.successThreshold).toBe(0.5);
    expect(mocks.readRoutingStats).toHaveBeenCalledWith(
      expect.objectContaining({ taskClass: "custom/class" }),
    );
  });
});
