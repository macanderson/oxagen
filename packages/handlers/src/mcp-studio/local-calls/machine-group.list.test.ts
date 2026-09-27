// list_machine_groups: the roles the contract grants, including the workspace
// readers, the group filter, and the listed shape with ISO times and a
// revoked machine still shown, against the in-memory store. The role gate
// runs for real against a role fixture.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { tachoMachineGroupList } from "@oxagen/oxagen/contracts/tacho.machine_group.list";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = vi.fn(() => Promise.reject(new Error("a unit test opened a database")));
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("../../test-utils/org-role-gate")).orgRoleModule(),
);

import { TEST_CTX } from "../../test-utils/fixtures";
import { memoryMachineGroupStore } from "../../test-utils/machine-group-store";
import { resetRoleGate, roleGate } from "../../test-utils/org-role-gate";
import { createTachoMachineGroupListHandler } from "./machine-group.list";

const MAC_1 = "tch_4q8r1t6v3x5z0b2d7h2k9m";
const MAC_2 = "tch_9z9z9z9z9z9z9z9z9z9z9z";
const NOW = new Date("2026-09-27T09:00:00.000Z");

function setup() {
  const { store, memberships, scopes } = memoryMachineGroupStore(
    {
      [MAC_1]: { hostname: "mac-1", status: "active" },
      [MAC_2]: { hostname: "mac-2", status: "revoked" },
    },
    () => NOW,
  );
  memberships.push(
    { group: "dev-laptops", machineId: MAC_2, addedAt: NOW, addedByUserId: null },
    { group: "ci-runners", machineId: MAC_1, addedAt: NOW, addedByUserId: null },
    { group: "dev-laptops", machineId: MAC_1, addedAt: NOW, addedByUserId: null },
  );
  const opened = { count: 0 };
  const handler = createTachoMachineGroupListHandler({
    withStore: (fn) => {
      opened.count += 1;
      return fn(store);
    },
  });
  const list = (input: { group?: string } = {}) =>
    handler(tachoMachineGroupList.input.parse(input), TEST_CTX);
  return { list, scopes, opened };
}

describe("list_machine_groups handler", () => {
  beforeEach(() => resetRoleGate());

  it("lists every group, a revoked machine included, for a workspace Viewer", async () => {
    roleGate.roles = { org: null, workspace: "Viewer" };
    const t = setup();
    const listing = await t.list();
    expect(tachoMachineGroupList.output.parse(listing)).toEqual(listing);
    expect(listing).toEqual({
      groups: [
        {
          group: "ci-runners",
          machines: [
            { machineId: MAC_1, hostname: "mac-1", status: "active", addedAt: NOW.toISOString() },
          ],
        },
        {
          group: "dev-laptops",
          machines: [
            { machineId: MAC_1, hostname: "mac-1", status: "active", addedAt: NOW.toISOString() },
            { machineId: MAC_2, hostname: "mac-2", status: "revoked", addedAt: NOW.toISOString() },
          ],
        },
      ],
    });
    expect(t.scopes).toEqual([{ orgId: TEST_CTX.orgId, workspaceId: TEST_CTX.workspaceId }]);
  });

  it("reads one group when the input names it", async () => {
    const t = setup();
    const listing = await t.list({ group: "ci-runners" });
    expect(listing.groups.map((g) => g.group)).toEqual(["ci-runners"]);
  });

  it("refuses a caller with no role on the workspace before any read", async () => {
    roleGate.roles = { org: null, workspace: null };
    const t = setup();
    const err = await t.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isHandlerError(err) && err.code).toBe("forbidden");
    expect(t.opened.count).toBe(0);
  });
});
