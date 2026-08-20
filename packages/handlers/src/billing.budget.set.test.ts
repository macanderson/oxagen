import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  setSpendBudget: vi.fn(),
  getSpendBudget: vi.fn(),
  invalidateSpendBudgetScope: vi.fn(),
  getSpendBudgetStatuses: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  setSpendBudget: mocks.setSpendBudget,
  getSpendBudget: mocks.getSpendBudget,
  invalidateSpendBudgetScope: mocks.invalidateSpendBudgetScope,
  getSpendBudgetStatuses: mocks.getSpendBudgetStatuses,
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
}));

import { billingBudgetSetHandler } from "./billing.budget.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function statusFor(scope: "org" | "workspace") {
  return {
    budget: {
      scope,
      orgId: "org_1",
      workspaceId: scope === "workspace" ? "ws_1" : null,
      enabled: true,
      period: "monthly",
      windowDays: null,
      limitMicros: 500_000_000n, // $500
      id: "bdg-1",
      publicId: "bdg_abc",
      notifiedThreshold: 0,
      notifiedPeriodStart: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-21T00:00:00Z"),
    },
    spentMicros: 0n,
    ratio: 0,
    state: "ok",
    overLimit: false,
    reachedThreshold: 0,
    window: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    },
    projectedMicros: 0n,
  };
}

describe("billingBudgetSetHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.setSpendBudget.mockReset();
    mocks.getSpendBudget.mockReset().mockResolvedValue(null);
    mocks.invalidateSpendBudgetScope.mockReset();
    mocks.getSpendBudgetStatuses.mockReset();
    mocks.emitSecurityEvent.mockReset();
  });

  it("org scope → workspaceId null, USD→micros, invalidates cache, returns saved status", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("org")]);

    const out = await billingBudgetSetHandler(
      { scope: "org", enabled: true, period: "monthly", limitUsd: 500 },
      CTX,
    );

    expect(mocks.setSpendBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: null,
        limitMicros: 500_000_000n,
        period: "monthly",
        windowDays: null,
        actorUserId: "u_1",
      }),
    );
    expect(mocks.invalidateSpendBudgetScope).toHaveBeenCalledWith({
      orgId: "org_1",
    });
    expect(out.scope).toBe("org");
    expect(out.limitUsd).toBe(500);
  });

  it("workspace scope → workspaceId from ctx", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("workspace")]);

    const out = await billingBudgetSetHandler(
      { scope: "workspace", enabled: true, period: "monthly", limitUsd: 500 },
      CTX,
    );

    expect(mocks.setSpendBudget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1" }),
    );
    expect(out.scope).toBe("workspace");
  });

  it("rolling scope forwards windowDays", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("org")]);

    await billingBudgetSetHandler(
      {
        scope: "org",
        enabled: true,
        period: "rolling",
        windowDays: 7,
        limitUsd: 50,
      },
      CTX,
    );
    expect(mocks.setSpendBudget).toHaveBeenCalledWith(
      expect.objectContaining({ period: "rolling", windowDays: 7 }),
    );
  });

  it("emits billing.budget_updated with actor, org, and scope", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("org")]);

    await billingBudgetSetHandler(
      { scope: "org", enabled: true, period: "monthly", limitUsd: 500 },
      CTX,
    );

    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.budget_updated",
        actorUserId: "u_1",
        orgId: "org_1",
        workspaceId: null,
        capability: "set_spend_budget",
        outcome: "success",
      }),
    );
  });

  it("throws if the saved scope is not found on read-back", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([]); // nothing found
    await expect(
      billingBudgetSetHandler(
        { scope: "org", enabled: true, period: "monthly", limitUsd: 500 },
        CTX,
      ),
    ).rejects.toThrow("not found on read-back");
  });
});
