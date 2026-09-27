// remove_group_machine: the org role gate, the removal, the no-op when the
// membership is absent, and one audit event per decision, against the
// in-memory store and audit sink. The role gate runs for real against a role
// fixture.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
import { tachoMachineGroupRemove } from "@oxagen/oxagen/contracts/tacho.machine_group.remove";

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
import type { AuditEvent } from "./machine-group.add";
import { createTachoMachineGroupRemoveHandler } from "./machine-group.remove";

const MACHINE = "tch_4q8r1t6v3x5z0b2d7h2k9m";
const NOW = new Date("2026-09-27T09:00:00.000Z");
const CTX: CapabilityContext = TEST_CTX;

async function setup() {
  const { store, memberships, scopes } = memoryMachineGroupStore(
    { [MACHINE]: { hostname: "mac-1", status: "revoked" } },
    () => NOW,
  );
  // The fixture machine is revoked, so seed its membership directly: a
  // revoked machine keeps the memberships it had before revocation.
  memberships.push({ group: "dev-laptops", machineId: MACHINE, addedAt: NOW, addedByUserId: null });
  const events: AuditEvent[] = [];
  const opened = { count: 0 };
  const handler = createTachoMachineGroupRemoveHandler({
    withStore: (fn) => {
      opened.count += 1;
      return fn(store, async (event) => {
        events.push(event);
      });
    },
    now: () => NOW,
  });
  const remove = (group: string) =>
    handler(tachoMachineGroupRemove.input.parse({ group, machineId: MACHINE }), CTX);
  return { remove, events, memberships, scopes, opened };
}

describe("remove_group_machine handler", () => {
  beforeEach(() => resetRoleGate());

  it("removes a revoked machine's membership and records the decision", async () => {
    const t = await setup();
    await expect(t.remove("dev-laptops")).resolves.toEqual({
      group: "dev-laptops",
      machineId: MACHINE,
      removed: true,
    });
    expect(t.memberships).toEqual([]);
    expect(t.scopes).toEqual([{ orgId: CTX.orgId, workspaceId: CTX.workspaceId }]);
    expect(t.events).toEqual([
      {
        eventType: "tacho.machine_group_changed",
        actorUserId: CTX.userId,
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        capability: "remove_group_machine",
        outcome: "success",
        occurredAt: NOW,
        ip: null,
        userAgent: null,
        requestId: CTX.requestId,
        detail: { change: "removed", group: "dev-laptops", machineId: MACHINE, changed: true },
      },
    ]);
  });

  it("changes nothing when the membership is absent and records that", async () => {
    const t = await setup();
    await expect(t.remove("ci-runners")).resolves.toEqual({
      group: "ci-runners",
      machineId: MACHINE,
      removed: false,
    });
    expect(t.memberships).toHaveLength(1);
    expect(t.events.map((e) => e.detail)).toEqual([
      { change: "removed", group: "ci-runners", machineId: MACHINE, changed: false },
    ]);
  });

  it("refuses a workspace Member before any read", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    const t = await setup();
    const err = await t.remove("dev-laptops").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isHandlerError(err) && err.code).toBe("forbidden");
    expect(t.opened.count).toBe(0);
    expect(t.memberships).toHaveLength(1);
  });
});
