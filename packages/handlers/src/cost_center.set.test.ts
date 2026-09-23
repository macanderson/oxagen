import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import { costCenterSetHandler } from "./cost_center.set";
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

function useTx(double: TxDouble) {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(double.tx),
  );
}

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

describe("set_cost_center", () => {
  it("refuses a member outside Owner, Admin and Billing before touching a row", async () => {
    roleGate.refuse = true;
    await expect(
      costCenterSetHandler(
        { target: "workspace", costCenter: "ENG-1001" },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: CTX.userId }),
      { org: ["Owner", "Admin", "Billing"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a label that is not live on the list with not_found", async () => {
    const double = makeTx({ selects: [[]] });
    useTx(double);
    await expect(
      costCenterSetHandler({ target: "workspace", costCenter: "OPS-9" }, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "cost_center_not_found",
    });
    expect(double.calls.updates).toEqual([]);
  });

  it("stores the list's spelling of the label on the workspace", async () => {
    // The column is citext, so `eng-1001` finds the list's `ENG-1001`.
    const double = makeTx({
      selects: [[centerRow({ label: "ENG-1001" })]],
      updates: [[{ id: "wrk_1" }]],
    });
    useTx(double);
    const out = await costCenterSetHandler(
      { target: "workspace", costCenter: "eng-1001" },
      CTX,
    );
    expect(double.calls.updates).toHaveLength(1);
    expect(double.calls.updates[0]?.table).toBe(schema.workspaces);
    expect(double.calls.updates[0]?.values).toMatchObject({
      costCenter: "ENG-1001",
      updatedById: CTX.userId,
    });
    expect(costCenterSet.output.parse(out)).toEqual({
      target: "workspace",
      id: "wrk_1",
      costCenter: "ENG-1001",
    });
  });

  it("clears an agent's label with null without reading the list", async () => {
    const double = makeTx({ updates: [[{ id: "agt_1" }]] });
    useTx(double);
    const out = await costCenterSetHandler(
      { target: "agent", agent: "reviewer", costCenter: null },
      CTX,
    );
    expect(double.calls.selects).toBe(0);
    expect(double.calls.updates[0]?.table).toBe(schema.agents);
    expect(double.calls.updates[0]?.values).toMatchObject({ costCenter: null });
    expect(out).toEqual({ target: "agent", id: "agt_1", costCenter: null });
  });

  it("answers not_found for an agent slug the workspace does not have", async () => {
    const double = makeTx({ selects: [[centerRow()]], updates: [[]] });
    useTx(double);
    await expect(
      costCenterSetHandler(
        { target: "agent", agent: "ghost", costCenter: "ENG-1001" },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "agent_not_found" });
  });

  it("answers not_found when the workspace is not in the organization", async () => {
    const double = makeTx({ updates: [[]] });
    useTx(double);
    await expect(
      costCenterSetHandler({ target: "workspace", costCenter: null }, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
  });
});
