import { beforeEach, describe, expect, it, vi } from "vitest";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { costCenterListHandler } from "./cost_center.list";
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

describe("list_cost_centers", () => {
  it("answers each live label with the agents and workspaces that name it", async () => {
    const double = makeTx({
      selects: [
        // The live labels, as ordered by the query.
        [
          centerRow({ publicId: "ccn_1", label: "ENG-1001" }),
          centerRow({
            publicId: "ccn_2",
            label: "MKT-2002",
            description: null,
          }),
        ],
        // Agent counts, keyed by lower-cased label.
        [{ label: "eng-1001", n: 2 }],
        // Workspace counts.
        [
          { label: "eng-1001", n: 1 },
          { label: "mkt-2002", n: "3" },
        ],
      ],
    });
    useTx(double);
    const out = costCenterList.output.parse(
      await costCenterListHandler({}, CTX),
    );
    expect(out.costCenters).toEqual([
      {
        id: "ccn_1",
        label: "ENG-1001",
        description: "Platform engineering",
        agents: 2,
        workspaces: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "ccn_2",
        label: "MKT-2002",
        description: null,
        agents: 0,
        workspaces: 3,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    // Every member may read the list, so the handler asserts no org role.
    expect(roleGate.assertOrgRole).not.toHaveBeenCalled();
  });

  it("answers an empty list for an organization with no labels", async () => {
    useTx(makeTx({ selects: [[], [], []] }));
    expect(await costCenterListHandler({}, CTX)).toEqual({ costCenters: [] });
  });
});
