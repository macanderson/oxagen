/**
 * Unit tests for the list_kill_switches handler (#2958). Tier-free org; the
 * role gate runs for real against a tx double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import type { KillSwitchRow } from "@oxagen/iam";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { createKillSwitchListHandler } from "./kill_switch.list";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const OTHER = "0192d4a8-7c1e-7a00-8000-0000000005e2";

const ctx = () => makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

function stubRole(orgRole: string | null, wsRole: string | null = null) {
  let leg: 1 | 2 = 2;
  let legResolved = true;
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) {
      leg = leg === 1 && !legResolved ? 2 : 1;
      return [{ id: "prn_1" }];
    }
    if (table === schema.principalRoleAssignments) {
      const role = leg === 1 ? orgRole : wsRole;
      legResolved = role !== null;
      return role ? [{ roleName: role }] : [];
    }
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
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
    ),
  );
}

const on: KillSwitchRow = {
  id: "id_1",
  publicId: "emd_1",
  targetKind: "class",
  targetId: "moves_money",
  scopeKind: "org",
  workspaceId: null,
  capabilityId: null,
  resourceScopeDigest: "sha256:" + "0".repeat(64),
  principalId: null,
  reason: "processor incident",
  active: true,
  activatedAt: new Date("2026-09-15T00:00:00.000Z"),
  deactivatedAt: null,
  flippedByUserId: USER,
  updatedById: USER,
};
const off: KillSwitchRow = {
  ...on,
  id: "id_2",
  publicId: "emd_2",
  targetKind: "tool_server",
  targetId: "mcs_github",
  scopeKind: "workspace",
  workspaceId: WS,
  active: false,
  deactivatedAt: new Date("2026-09-15T02:00:00.000Z"),
  updatedById: OTHER,
};

function handlerOver(rows: KillSwitchRow[]) {
  const read = vi.fn(async (scope: { onlyOn: boolean; limit: number }) => ({
    generation: { org: 5, workspace: 2 },
    rows: rows.filter((r) => !scope.onlyOn || r.active).slice(0, scope.limit),
  }));
  return { handler: createKillSwitchListHandler({ read }), read };
}

beforeEach(() => {
  stubRole(null, "Member");
});

describe("list_kill_switches", () => {
  it("lists the switches with the current deny generation, who flipped and who cleared each", async () => {
    const { handler, read } = handlerOver([on, off]);
    const out = await handler({ onlyOn: false, limit: 100 }, ctx());
    expect(read).toHaveBeenCalledWith({
      orgId: ORG,
      workspaceId: WS,
      onlyOn: false,
      limit: 100,
    });
    expect(out.denyGeneration).toEqual({ org: 5, workspace: 2 });
    expect(out.switches).toEqual([
      {
        id: "emd_1",
        target: { kind: "class", id: "moves_money" },
        scope: "org",
        on: true,
        reason: "processor incident",
        flippedBy: USER,
        flippedAt: "2026-09-15T00:00:00.000Z",
        clearedAt: null,
        clearedBy: null,
      },
      {
        id: "emd_2",
        target: { kind: "tool_server", id: "mcs_github" },
        scope: "workspace",
        on: false,
        reason: "processor incident",
        flippedBy: USER,
        flippedAt: "2026-09-15T00:00:00.000Z",
        clearedAt: "2026-09-15T02:00:00.000Z",
        clearedBy: OTHER,
      },
    ]);
  });

  it("onlyOn drops the cleared switches", async () => {
    const { handler } = handlerOver([on, off]);
    const out = await handler({ onlyOn: true, limit: 100 }, ctx());
    expect(out.switches.map((s) => s.id)).toEqual(["emd_1"]);
  });

  it.each([
    ["Billing", null],
    [null, "Viewer"],
    [null, null],
  ] as const)(
    "refuses a tier-free user holding org %s / workspace %s",
    async (org, ws) => {
      stubRole(org, ws);
      const { handler } = handlerOver([on]);
      const err = await handler({ onlyOn: false, limit: 100 }, ctx()).catch(
        (e: unknown) => e,
      );
      expect(isHandlerError(err) && err.code).toBe("forbidden");
    },
  );
});
