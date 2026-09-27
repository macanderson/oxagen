// add_group_machine: the org role gate, the membership it writes, the no-op on
// a second add, and one audit event per decision, against the in-memory store
// and audit sink. The role gate runs for real against a role fixture.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
import { tachoMachineGroupAdd } from "@oxagen/oxagen/contracts/tacho.machine_group.add";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The handler under test reads through the in-memory store. A call that
  // reached the real seam would be a defect in the test.
  const withTenantDb = vi.fn(() => Promise.reject(new Error("a unit test opened a database")));
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("../../test-utils/org-role-gate")).orgRoleModule(),
);

import { TEST_CTX } from "../../test-utils/fixtures";
import { memoryMachineGroupStore } from "../../test-utils/machine-group-store";
import { resetRoleGate, roleGate } from "../../test-utils/org-role-gate";
import { type AuditEvent, createTachoMachineGroupAddHandler } from "./machine-group.add";

const MACHINE = "tch_4q8r1t6v3x5z0b2d7h2k9m";
const REVOKED = "tch_0000000000000000000rv1";
const NOW = new Date("2026-09-27T09:00:00.000Z");
const LATER = new Date("2026-09-27T10:00:00.000Z");
const CTX: CapabilityContext = { ...TEST_CTX, clientIp: "203.0.113.9" };

function setup() {
  let clock = NOW;
  const { store, memberships, scopes } = memoryMachineGroupStore(
    {
      [MACHINE]: { hostname: "mac-1", status: "active" },
      [REVOKED]: { hostname: "mac-2", status: "revoked" },
    },
    () => clock,
  );
  const events: AuditEvent[] = [];
  const opened = { count: 0 };
  const handler = createTachoMachineGroupAddHandler({
    withStore: (fn) => {
      opened.count += 1;
      return fn(store, async (event) => {
        events.push(event);
      });
    },
    now: () => clock,
  });
  const add = (group: string, machineId: string, ctx: CapabilityContext = CTX) =>
    handler(tachoMachineGroupAdd.input.parse({ group, machineId }), ctx);
  return {
    add,
    events,
    memberships,
    scopes,
    opened,
    tick: () => {
      clock = LATER;
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!isHandlerError(err)) throw new Error(`expected a HandlerError, got ${String(err)}`);
  return err;
}

describe("add_group_machine handler", () => {
  beforeEach(() => resetRoleGate());

  it("adds the machine for an org Owner and records the decision", async () => {
    const t = setup();
    await expect(t.add("dev-laptops", MACHINE)).resolves.toEqual({
      group: "dev-laptops",
      machineId: MACHINE,
      addedAt: NOW.toISOString(),
      added: true,
    });
    expect(t.scopes).toEqual([{ orgId: CTX.orgId, workspaceId: CTX.workspaceId }]);
    expect(t.memberships).toEqual([
      { group: "dev-laptops", machineId: MACHINE, addedAt: NOW, addedByUserId: CTX.userId },
    ]);
    expect(t.events).toEqual([
      {
        eventType: "tacho.machine_group_changed",
        actorUserId: CTX.userId,
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        capability: "add_group_machine",
        outcome: "success",
        occurredAt: NOW,
        ip: "203.0.113.9",
        userAgent: null,
        requestId: CTX.requestId,
        detail: { change: "added", group: "dev-laptops", machineId: MACHINE, changed: true },
      },
    ]);
  });

  it("leaves a machine already in the group as it is and says so", async () => {
    const t = setup();
    await t.add("dev-laptops", MACHINE);
    t.tick();
    await expect(t.add("dev-laptops", MACHINE)).resolves.toEqual({
      group: "dev-laptops",
      machineId: MACHINE,
      addedAt: NOW.toISOString(),
      added: false,
    });
    expect(t.memberships).toHaveLength(1);
    expect(t.events.map((e) => e.detail)).toEqual([
      { change: "added", group: "dev-laptops", machineId: MACHINE, changed: true },
      { change: "added", group: "dev-laptops", machineId: MACHINE, changed: false },
    ]);
  });

  it("admits an org Admin", async () => {
    roleGate.roles = { org: "Admin" };
    const t = setup();
    await expect(t.add("ci-runners", MACHINE)).resolves.toMatchObject({ added: true });
  });

  it("refuses a workspace Owner before any read", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    const t = setup();
    const err = await refusal(t.add("dev-laptops", MACHINE));
    expect(err).toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(t.opened.count).toBe(0);
    expect(t.events).toEqual([]);
  });

  it("acts as an API key's creator", async () => {
    const creator = "00000000-0000-4000-8000-0000000000c7";
    roleGate.roles = { org: "Owner", keyCreator: creator };
    const t = setup();
    const keyCall: CapabilityContext = {
      ...CTX,
      userId: null,
      apiKeyId: "00000000-0000-4000-8000-0000000000a9",
      surface: "mcp",
    };
    await t.add("dev-laptops", MACHINE, keyCall);
    expect(t.memberships[0]?.addedByUserId).toBe(creator);
    expect(t.events[0]?.actorUserId).toBe(creator);
  });

  it("refuses an API key with no creator", async () => {
    roleGate.roles = { org: "Owner", keyCreator: null };
    const t = setup();
    const err = await refusal(
      t.add("dev-laptops", MACHINE, {
        ...CTX,
        userId: null,
        apiKeyId: "00000000-0000-4000-8000-0000000000a9",
      }),
    );
    expect(err.code).toBe("forbidden");
    expect(t.opened.count).toBe(0);
  });

  it("passes the store's refusal on and records nothing", async () => {
    const t = setup();
    await expect(refusal(t.add("dev-laptops", REVOKED))).resolves.toMatchObject({
      code: "conflict",
      reason: "machine_revoked",
    });
    await expect(
      refusal(t.add("dev-laptops", "tch_zzzzzzzzzzzzzzzzzzzzzz")),
    ).resolves.toMatchObject({ code: "not_found", reason: "machine_not_found" });
    expect(t.events).toEqual([]);
  });
});
