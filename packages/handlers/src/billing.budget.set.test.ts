import { describe, expect, it, vi, beforeEach } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
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

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
}));

import { billingBudgetSetHandler } from "./billing.budget.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

/**
 * The role gate runs for real against a tx double that answers the principal
 * and role-assignment tables: `org` names the org-wide role, `workspace` the
 * role on the context's workspace (INV-29, a tier-free org).
 */
function stubRoles(roles: { org?: string; workspace?: string }) {
  // Each lookup opens its own withTenantDb, so the count spans the calls.
  let assignmentReads = 0;
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === schema.principals) return [{ id: "prn_1" }];
      if (table === schema.principalRoleAssignments) {
        // resolveActorOrgRole reads the org leg first, the workspace leg after.
        const role = assignmentReads++ === 0 ? roles.org : roles.workspace;
        return role ? [{ roleName: role }] : [];
      }
      throw new Error("unexpected table");
    };
    return Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    );
  });
}

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
    stubRoles({ org: "Owner" });
    mocks.setSpendBudget.mockReset();
    mocks.getSpendBudget.mockReset().mockResolvedValue(null);
    mocks.invalidateSpendBudgetScope.mockReset();
    mocks.getSpendBudgetStatuses.mockReset();
    mocks.emitSecurityEvent.mockReset();
  });

  it("org scope → workspaceId null, micros as given, invalidates cache, returns saved status", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("org")]);

    const out = await billingBudgetSetHandler(
      {
        scope: "org",
        enabled: true,
        period: "monthly",
        limit: { micros: "500000000", currency: "USD" },
      },
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
    // Both reads name the caller's org rather than trusting RLS alone (#2976).
    expect(mocks.getSpendBudget).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: null,
    });
    expect(mocks.getSpendBudgetStatuses).toHaveBeenCalledWith({
      orgId: "org_1",
    });
    expect(out.scope).toBe("org");
    expect(out.limit).toEqual({ micros: "500000000", currency: "USD" });
  });

  it("workspace scope → workspaceId from ctx", async () => {
    mocks.setSpendBudget.mockResolvedValue({});
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("workspace")]);

    const out = await billingBudgetSetHandler(
      {
        scope: "workspace",
        enabled: true,
        period: "monthly",
        limit: { micros: "500000000", currency: "USD" },
      },
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
        limit: { micros: "50000000", currency: "USD" },
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
      {
        scope: "org",
        enabled: true,
        period: "monthly",
        limit: { micros: "500000000", currency: "USD" },
      },
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
        {
          scope: "org",
          enabled: true,
          period: "monthly",
          limit: { micros: "500000000", currency: "USD" },
        },
        CTX,
      ),
    ).rejects.toThrow("not found on read-back");
  });
});

describe("set_spend_budget — the role gate (INV-29)", () => {
  const orgCeiling = {
    scope: "org" as const,
    enabled: true,
    period: "monthly" as const,
    limit: { micros: "500000000", currency: "USD" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSpendBudget.mockResolvedValue(null);
    mocks.setSpendBudget.mockResolvedValue({});
  });

  it.each(["Owner", "Admin", "Billing"])(
    "lets an org %s set the org ceiling",
    async (role) => {
      stubRoles({ org: role });
      mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("org")]);
      const out = await billingBudgetSetHandler(orgCeiling, CTX);
      expect(out.scope).toBe("org");
      expect(mocks.setSpendBudget).toHaveBeenCalledOnce();
    },
  );

  it.each(["Member", "Viewer", "Compliance"])(
    "refuses an org %s with forbidden and writes nothing (negative)",
    async (role) => {
      stubRoles({ org: role });
      const err = await billingBudgetSetHandler(orgCeiling, CTX).catch(
        (e: unknown) => e,
      );
      expect(isHandlerError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("forbidden");
      expect(mocks.setSpendBudget).not.toHaveBeenCalled();
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("lets a workspace Admin set that workspace's ceiling and refuses the org ceiling (negative)", async () => {
    stubRoles({ org: "Member", workspace: "Admin" });
    mocks.getSpendBudgetStatuses.mockResolvedValue([statusFor("workspace")]);
    const out = await billingBudgetSetHandler(
      { ...orgCeiling, scope: "workspace" },
      CTX,
    );
    expect(out.scope).toBe("workspace");

    vi.clearAllMocks();
    stubRoles({ org: "Member", workspace: "Admin" });
    const err = await billingBudgetSetHandler(orgCeiling, CTX).catch(
      (e: unknown) => e,
    );
    expect((err as { code: string }).code).toBe("forbidden");
    expect(mocks.setSpendBudget).not.toHaveBeenCalled();
  });

  it("refuses a call with no signed-in user and no API key (negative)", async () => {
    stubRoles({ org: "Owner" });
    const err = await billingBudgetSetHandler(orgCeiling, {
      ...CTX,
      userId: null,
    }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("forbidden");
    expect(mocks.setSpendBudget).not.toHaveBeenCalled();
  });

  it("fails the call when the read-back's spend read fails, after the write (negative, #3064)", async () => {
    stubRoles({ org: "Owner" });
    mocks.getSpendBudgetStatuses.mockRejectedValue(new Error("counter down"));
    await expect(billingBudgetSetHandler(orgCeiling, CTX)).rejects.toThrow(
      "counter down",
    );
    expect(mocks.setSpendBudget).toHaveBeenCalledOnce();
  });
});
