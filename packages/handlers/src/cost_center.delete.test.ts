import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { costCenterDeleteHandler } from "./cost_center.delete";
import { centerRow, makeTx, type TxDouble } from "./cost_center.test-support";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is the SAME function as the tenant seam (ADR-086), so a
  // suite that counts seam calls sees one identity.
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});

// The org-role gate (INV-29). Allows by default, an org Billing member, so each
// case tests its own behaviour. The refusal cases set `roleGate.refuse`.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Billing";
  }),
}));

// The agents are cleared in each workspace's own scope. The double records the
// scopes it was asked for and runs the callback without the UUID checks.
const tenancy = vi.hoisted(() => ({
  scopes: [] as { orgId: string; workspaceId: string }[],
}));
vi.mock("@oxagen/tenancy", () => ({
  getPrincipalAttribution: () => ({}),
  runInTenantScope: (
    scope: { orgId: string; workspaceId: string },
    fn: () => unknown,
  ) => {
    tenancy.scopes.push({ orgId: scope.orgId, workspaceId: scope.workspaceId });
    return fn();
  },
}));

vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));

function useTx(double: TxDouble) {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(double.tx),
  );
}

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  tenancy.scopes = [];
});

describe("delete_cost_center", () => {
  it("refuses a member outside Owner, Admin and Billing before touching the list", async () => {
    roleGate.refuse = true;
    await expect(
      costCenterDeleteHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("soft-deletes a live label and answers when", async () => {
    const at = new Date("2026-09-22T12:00:00.000Z");
    const double = makeTx({
      selects: [[centerRow()], [], [centerRow()]],
      updates: [[], [centerRow({ deletedAt: at, deletedById: CTX.userId })]],
    });
    useTx(double);
    const out = await costCenterDeleteHandler({ label: "ENG-1001" }, CTX);
    const center = double.calls.updates.find(
      (u) => u.table === schema.costCenters,
    );
    expect(center?.values).toMatchObject({
      deletedById: CTX.userId,
      updatedById: CTX.userId,
    });
    expect(center?.values.deletedAt).toBeInstanceOf(Date);
    expect(out).toEqual({ label: "ENG-1001", deletedAt: at.toISOString() });
  });

  it("clears the label from every agent and workspace that names it (#3750)", async () => {
    const at = new Date("2026-09-22T12:00:00.000Z");
    const double = makeTx({
      // The live row, the two workspaces holding an agent that names it, and
      // the live row again in the transaction that deletes it.
      selects: [
        [centerRow()],
        [{ workspaceId: "ws_a" }, { workspaceId: "ws_b" }],
        [centerRow()],
      ],
      updates: [
        [{ id: "agent_1" }, { id: "agent_2" }],
        [{ id: "agent_3" }],
        [{ id: "ws_row_1" }],
        [centerRow({ deletedAt: at, deletedById: CTX.userId })],
      ],
    });
    useTx(double);
    const out = await costCenterDeleteHandler({ label: "ENG-1001" }, CTX);
    expect(out.label).toBe("ENG-1001");
    // Each workspace's agents are written in that workspace's own scope,
    // since an org-wide transaction cannot write a standard table (ADR-086).
    expect(tenancy.scopes).toEqual([
      { orgId: CTX.orgId, workspaceId: "ws_a" },
      { orgId: CTX.orgId, workspaceId: "ws_b" },
    ]);
    expect(double.calls.updates.map((u) => u.table)).toEqual([
      schema.agents,
      schema.agents,
      schema.workspaces,
      schema.costCenters,
    ]);
    for (const update of double.calls.updates.slice(0, 3)) {
      expect(update.values).toMatchObject({
        costCenter: null,
        updatedById: CTX.userId,
      });
      expect(update.where).toBeDefined();
    }
    // The label goes off the list in the same transaction that clears the
    // workspaces, so no workspace keeps a label the list no longer has.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(4);
  });

  it("clears nothing when the label is not live", async () => {
    const double = makeTx({ selects: [[]] });
    useTx(double);
    await expect(
      costCenterDeleteHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({ reason: "cost_center_not_found" });
    expect(tenancy.scopes).toEqual([]);
    expect(double.calls.updates).toEqual([]);
  });

  it("answers not_found for a label that is not live", async () => {
    const double = makeTx({ selects: [[]] });
    useTx(double);
    await expect(
      costCenterDeleteHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "cost_center_not_found",
    });
    expect(double.calls.updates).toEqual([]);
  });
});
