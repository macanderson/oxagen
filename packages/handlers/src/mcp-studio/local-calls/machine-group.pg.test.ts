// Machine groups against a real Postgres: add, the no-op second add, the
// refusals for a revoked machine and for one enrolled in another workspace,
// the gateway reader skipping a revoked or suspended host (#4554), the list
// keeping both, removal and
// the no-op second removal, and one security event per decision. Runs wherever
// DATABASE_URL points at a migrated database. CI's unit job migrates Postgres
// with Atlas first, and a local run without one is skipped, not red. Every row
// it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
import { tachoMachineGroupAdd } from "@oxagen/oxagen/contracts/tacho.machine_group.add";
import { tachoMachineGroupList } from "@oxagen/oxagen/contracts/tacho.machine_group.list";
import { tachoMachineGroupRemove } from "@oxagen/oxagen/contracts/tacho.machine_group.remove";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import { postgresMachineGroupReader } from "./groups-store";
import { tachoMachineGroupAddHandler } from "./machine-group.add";
import { tachoMachineGroupListHandler } from "./machine-group.list";
import { tachoMachineGroupRemoveHandler } from "./machine-group.remove";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("machine groups against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const scope = { orgId, workspaceId };

  const hostKeys = ["active", "revoked", "elsewhere", "suspended"] as const;
  type HostKey = (typeof hostKeys)[number];
  const hostIds = Object.fromEntries(
    hostKeys.map((k) => [k, crypto.randomUUID()]),
  ) as Record<HostKey, string>;
  const apiKeyIds = Object.fromEntries(
    hostKeys.map((k) => [k, crypto.randomUUID()]),
  ) as Record<HostKey, string>;
  const machines = Object.fromEntries(
    hostKeys.map((k, i) => [k, `tch_${tag}0000000000000${i}`]),
  ) as Record<HostKey, string>;

  const operator: CapabilityContext = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  };

  const inScope = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
  const add = (group: string, machineId: string) =>
    inScope(() =>
      tachoMachineGroupAddHandler(
        tachoMachineGroupAdd.input.parse({ group, machineId }),
        operator,
      ),
    );
  const remove = (group: string, machineId: string) =>
    inScope(() =>
      tachoMachineGroupRemoveHandler(
        tachoMachineGroupRemove.input.parse({ group, machineId }),
        operator,
      ),
    );
  const list = () =>
    inScope(() =>
      tachoMachineGroupListHandler(tachoMachineGroupList.input.parse({}), operator),
    );
  const refusal = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (!isHandlerError(err)) throw new Error(`expected a HandlerError, got ${String(err)}`);
    return err;
  };

  const host = (
    key: HostKey,
    over: { workspaceId?: string; status?: string; revokedAt?: Date } = {},
  ) => ({
    id: hostIds[key],
    publicId: machines[key],
    orgId,
    workspaceId,
    agentKey: `mg.core.${key}-${tag}`,
    apiKeyId: apiKeyIds[key],
    hostname: `${key}.local`,
    hostnameDigest: "sha256:0",
    platform: "darwin",
    osUser: "dev",
    osUserDigest: "sha256:0",
    devicePublicKey: "pk",
    deviceKeyFingerprint: "fp",
    enrollmentClaims: {},
    enrollmentSignature: "sig",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    status: "active",
    mode: "enforce",
    lastSeenAt: new Date(),
    bundleFeatures: [],
    ...over,
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `mg-${tag}@handlers.test`,
        status: "active",
      });
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Machine groups ${tag}`,
        slug: `mg-${tag}`,
        namespace: `m${tag.slice(0, 5)}`,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        { id: workspaceId, orgId, name: "Core", slug: "core", namespace: "core" },
        { id: otherWorkspaceId, orgId, name: "Other", slug: "other", namespace: "other" },
      ]);
      // The org Owner role the handlers' gate resolves for the operator.
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId,
          kind: "human",
          displayName: "Operator",
          status: "active",
          parentUserId: userId,
        })
        .returning({ id: schema.principals.id });
      const [role] = await tx
        .insert(schema.roles)
        .values({ orgId, scopeKind: "org", name: "Owner" })
        .returning({ id: schema.roles.id });
      if (!principal || !role) throw new Error("fixture insert returned no row");
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal.id,
        roleId: role.id,
        orgId,
      });
      await tx.insert(schema.apiKeys).values(
        hostKeys.map((k) => ({
          id: apiKeyIds[k],
          orgId,
          workspaceId: k === "elsewhere" ? otherWorkspaceId : workspaceId,
          keyPrefix: `oxk_${tag}${k.slice(0, 2)}`,
          keyHash: `hash-${tag}-${k}`,
          name: `tacho host ${k} ${tag}`,
          scope: { purpose: "tacho_host_v1", host_enrollment_id: machines[k] },
          createdById: userId,
        })),
      );
      await tx.insert(schema.tachoHosts).values([
        host("active"),
        // tacho_hosts_revoked_check ties the revoked status to revoked_at.
        host("revoked", { status: "revoked", revokedAt: new Date("2026-09-26T12:00:00.000Z") }),
        host("elsewhere", { workspaceId: otherWorkspaceId }),
        host("suspended", { status: "suspended" }),
      ]);
      // A membership the revoked host held before it was revoked. The add
      // capability refuses a revoked host, so the fixture writes the row. The
      // suspended host's row is written here too, so the security event count
      // below stays the adds and removals the test makes.
      await tx.insert(schema.tachoMachineGroupMembers).values([
        {
          orgId,
          workspaceId,
          groupName: "dev-laptops",
          hostId: hostIds.revoked,
          createdById: userId,
        },
        {
          orgId,
          workspaceId,
          groupName: "ci-runners",
          hostId: hostIds.suspended,
          createdById: userId,
        },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.securityEvents).where(eq(schema.securityEvents.orgId, orgId));
      await tx
        .delete(schema.tachoMachineGroupMembers)
        .where(eq(schema.tachoMachineGroupMembers.orgId, orgId));
      await tx
        .delete(schema.tachoHosts)
        .where(inArray(schema.tachoHosts.id, Object.values(hostIds)));
      await tx
        .delete(schema.apiKeys)
        .where(inArray(schema.apiKeys.id, Object.values(apiKeyIds)));
      await tx
        .delete(schema.principalRoleAssignments)
        .where(eq(schema.principalRoleAssignments.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("adds a machine once and answers the same row on a second add", async () => {
    const first = await add("dev-laptops", machines.active);
    expect(first).toMatchObject({ group: "dev-laptops", machineId: machines.active, added: true });
    const second = await add("dev-laptops", machines.active);
    expect(second).toEqual({ ...first, added: false });
    await add("ci-runners", machines.active);

    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoMachineGroupMembers)
        .where(eq(schema.tachoMachineGroupMembers.hostId, hostIds.active)),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ orgId, workspaceId, createdById: userId });
      expect(row.publicId).toMatch(/^tmg_/);
    }
  });

  it("refuses a revoked machine and one enrolled in another workspace", async () => {
    await expect(refusal(add("ci-runners", machines.revoked))).resolves.toMatchObject({
      code: "conflict",
      reason: "machine_revoked",
    });
    await expect(refusal(add("ci-runners", machines.elsewhere))).resolves.toMatchObject({
      code: "not_found",
      reason: "machine_not_found",
    });
  });

  it("gives the gateway a machine's groups in order and none for a revoked or suspended host", async () => {
    await expect(postgresMachineGroupReader.groupsOf(scope, machines.active)).resolves.toEqual([
      "ci-runners",
      "dev-laptops",
    ]);
    await expect(postgresMachineGroupReader.groupsOf(scope, machines.revoked)).resolves.toEqual(
      [],
    );
    await expect(
      postgresMachineGroupReader.groupsOf(scope, machines.suspended),
    ).resolves.toEqual([]);
    await expect(
      postgresMachineGroupReader.groupsOf(
        { orgId, workspaceId: otherWorkspaceId },
        machines.active,
      ),
    ).resolves.toEqual([]);
  });

  it("reads only the suspended host as suspended (#4554)", async () => {
    await expect(postgresMachineGroupReader.isSuspended(scope, machines.suspended)).resolves.toBe(
      true,
    );
    await expect(postgresMachineGroupReader.isSuspended(scope, machines.active)).resolves.toBe(
      false,
    );
    await expect(postgresMachineGroupReader.isSuspended(scope, machines.revoked)).resolves.toBe(
      false,
    );
    await expect(
      postgresMachineGroupReader.isSuspended(
        { orgId, workspaceId: otherWorkspaceId },
        machines.suspended,
      ),
    ).resolves.toBe(false);
  });

  it("lists every group with the revoked and suspended machines still shown", async () => {
    const listing = await list();
    expect(
      listing.groups.map((g) => [g.group, g.machines.map((m) => [m.machineId, m.status])]),
    ).toEqual([
      [
        "ci-runners",
        [
          [machines.active, "active"],
          [machines.suspended, "suspended"],
        ],
      ],
      [
        "dev-laptops",
        [
          [machines.active, "active"],
          [machines.revoked, "revoked"],
        ],
      ],
    ]);
  });

  it("removes a membership once and changes nothing on a second removal", async () => {
    await expect(remove("dev-laptops", machines.revoked)).resolves.toMatchObject({
      removed: true,
    });
    await expect(remove("dev-laptops", machines.revoked)).resolves.toMatchObject({
      removed: false,
    });
  });

  it("records one security event per decision, refusals excluded", async () => {
    const events = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.securityEvents)
        .where(
          and(
            eq(schema.securityEvents.orgId, orgId),
            eq(schema.securityEvents.eventType, "tacho.machine_group_changed"),
          ),
        ),
    );
    // Three adds and two removals. The two refused adds rolled back.
    expect(events).toHaveLength(5);
    const changes = events.map((e) => e.detail as { change: string; changed: boolean });
    expect(changes.filter((d) => d.change === "added" && d.changed)).toHaveLength(2);
    expect(changes.filter((d) => d.change === "added" && !d.changed)).toHaveLength(1);
    expect(changes.filter((d) => d.change === "removed" && d.changed)).toHaveLength(1);
    expect(changes.filter((d) => d.change === "removed" && !d.changed)).toHaveLength(1);
    for (const event of events)
      expect(event).toMatchObject({
        actorUserId: userId,
        workspaceId,
        outcome: "success",
        requestId: `req-${tag}`,
      });
  });
});
