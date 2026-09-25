import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { costCenterCreateHandler } from "./cost_center.create";
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

describe("create_cost_center", () => {
  it("refuses a member outside Owner, Admin and Billing before touching the list", async () => {
    roleGate.refuse = true;
    await expect(
      costCenterCreateHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: CTX.userId }),
      { org: ["Owner", "Admin", "Billing"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("adds a new label to the list", async () => {
    const double = makeTx({ selects: [[]] });
    useTx(double);
    const out = await costCenterCreateHandler(
      { label: "ENG-1001", description: "Platform engineering" },
      CTX,
    );
    expect(double.calls.inserts).toEqual([
      {
        orgId: CTX.orgId,
        label: "ENG-1001",
        description: "Platform engineering",
        createdById: CTX.userId,
        updatedById: CTX.userId,
      },
    ]);
    expect(costCenterCreate.output.parse(out)).toEqual({
      costCenter: {
        id: "ccn_new",
        label: "ENG-1001",
        description: "Platform engineering",
        agents: 0,
        workspaces: 0,
        createdAt: "2026-09-22T12:00:00.000Z",
      },
    });
  });

  it("restores a label the organization deleted, keeping its row and description", async () => {
    const deleted = centerRow({
      deletedAt: new Date("2026-09-10T00:00:00.000Z"),
      deletedById: "u_0",
    });
    const double = makeTx({
      selects: [[deleted]],
      updates: [[{ ...deleted, deletedAt: null, deletedById: null }]],
    });
    useTx(double);
    const out = await costCenterCreateHandler({ label: "ENG-1001" }, CTX);
    expect(double.calls.inserts).toEqual([]);
    expect(double.calls.updates).toHaveLength(1);
    expect(double.calls.updates[0]?.table).toBe(schema.costCenters);
    expect(double.calls.updates[0]?.values).toMatchObject({
      deletedAt: null,
      deletedById: null,
      description: "Platform engineering",
      updatedById: CTX.userId,
    });
    expect(out.costCenter).toMatchObject({ id: "ccn_1", label: "ENG-1001" });
  });

  it("answers conflict for a label already live on the list", async () => {
    const double = makeTx({ selects: [[centerRow()]] });
    useTx(double);
    await expect(
      costCenterCreateHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({ code: "conflict", reason: "cost_center_exists" });
    expect(double.calls.inserts).toEqual([]);
    expect(double.calls.updates).toEqual([]);
  });

  it("answers conflict when a concurrent create wins the insert race", async () => {
    // Both creates read no row; the loser's insert hits the unique index.
    // drizzle wraps the driver error, so the SQLSTATE sits on the cause.
    const race = Object.assign(new Error("Failed query: insert into ..."), {
      cause: Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint_name: "cost_centers_org_label_idx",
      }),
    });
    const double = makeTx({ selects: [[]] });
    double.tx.insert = () => ({
      values: () => ({
        returning: async () => {
          throw race;
        },
      }),
    });
    useTx(double);
    await expect(
      costCenterCreateHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "cost_center_exists",
      message: "The cost center ENG-1001 is already on the list",
    });
  });

  it("rethrows a unique violation on any other index unchanged", async () => {
    const other = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint_name: "cost_centers_public_id_unique",
    });
    mocks.withTenantDb.mockRejectedValue(other);
    await expect(
      costCenterCreateHandler({ label: "ENG-1001" }, CTX),
    ).rejects.toBe(other);
  });
});
