import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSpendBudgetStatuses: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  getSpendBudgetStatuses: mocks.getSpendBudgetStatuses,
}));

import { billingBudgetGetHandler } from "./billing.budget.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function status(overrides: Record<string, unknown> = {}) {
  return {
    budget: {
      scope: "org",
      orgId: "org_1",
      workspaceId: null,
      enabled: true,
      period: "monthly",
      windowDays: null,
      limitMicros: 10_000_000n, // $10
      id: "bdg-1",
      publicId: "bdg_abc",
      notifiedThreshold: 0,
      notifiedPeriodStart: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    },
    spentMicros: 4_000_000n, // $4
    ratio: 0.4,
    state: "ok",
    overLimit: false,
    reachedThreshold: 0,
    window: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    },
    projectedMicros: 6_000_000n, // $6
    ...overrides,
  };
}

describe("billingBudgetGetHandler (@oxagen/handlers)", () => {
  beforeEach(() => mocks.getSpendBudgetStatuses.mockReset());

  it("returns an empty budgets array when nothing is configured", async () => {
    mocks.getSpendBudgetStatuses.mockResolvedValue([]);
    const out = await billingBudgetGetHandler({}, CTX);
    expect(out.budgets).toEqual([]);
  });

  it("maps a status to USD, preserving scope and window", async () => {
    mocks.getSpendBudgetStatuses.mockResolvedValue([status()]);
    const out = await billingBudgetGetHandler({}, CTX);
    expect(out.budgets).toHaveLength(1);
    const b = out.budgets[0]!;
    expect(b.scope).toBe("org");
    expect(b.limitUsd).toBe(10);
    expect(b.spentUsd).toBe(4);
    expect(b.projectedUsd).toBe(6);
    expect(b.publicId).toBe("bdg_abc");
    expect(b.windowStart).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns both scopes, org first", async () => {
    mocks.getSpendBudgetStatuses.mockResolvedValue([
      status(),
      status({
        budget: {
          ...status().budget,
          scope: "workspace",
          workspaceId: "ws_1",
          id: "bdg-2",
          publicId: "bdg_ws",
        },
      }),
    ]);
    const out = await billingBudgetGetHandler({}, CTX);
    expect(out.budgets.map((b) => b.scope)).toEqual(["org", "workspace"]);
  });
});
