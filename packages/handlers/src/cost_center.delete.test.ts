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
      selects: [[centerRow()]],
      updates: [[centerRow({ deletedAt: at, deletedById: CTX.userId })]],
    });
    useTx(double);
    const out = await costCenterDeleteHandler({ label: "ENG-1001" }, CTX);
    expect(double.calls.updates[0]?.table).toBe(schema.costCenters);
    expect(double.calls.updates[0]?.values).toMatchObject({
      deletedById: CTX.userId,
      updatedById: CTX.userId,
    });
    expect(double.calls.updates[0]?.values.deletedAt).toBeInstanceOf(Date);
    expect(out).toEqual({ label: "ENG-1001", deletedAt: at.toISOString() });
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
