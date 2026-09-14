// The run-control path against a real Postgres: dispatch_command writes one
// row per recipient with the resolved mode, supersedes the earlier queued
// steer and no other row, fetch_commands expires what the clock passed and
// drains queued rows as sent with their modes, an acknowledgement lands on an
// open row and never on a terminal one, and list_commands reads it all back
// with `expired` derived. Runs wherever DATABASE_URL points at a migrated
// database — CI's `test` job migrates Postgres with Atlas before
// `turbo run build test:unit`; a local run without one is skipped, not red.
// Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { tachoCommandDispatchHandler } from "./tacho.command.dispatch";
import { tachoCommandFetchHandler } from "./tacho.command.fetch";
import { tachoCommandListHandler } from "./tacho.command.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("run controls against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const hostPublicId = `tch_${tag}00000000000000`;
  const agentKey = `g2953.core.bot-${tag}`;
  const sessionIds = {
    live: crypto.randomUUID(),
    observe: crypto.randomUUID(),
    sealed: crypto.randomUUID(),
  };
  const sessionUuids = {
    live: crypto.randomUUID(),
    observe: crypto.randomUUID(),
    sealed: crypto.randomUUID(),
  };
  const publicIds = {
    live: `tse_${tag}0000000000000l`,
    observe: `tse_${tag}0000000000000o`,
    sealed: `tse_${tag}0000000000000s`,
  };

  const operator: CapabilityContext = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  };
  const machine: CapabilityContext = { ...operator, userId: null, apiKeyId };

  const scoped = <T>(fn: () => Promise<T>) =>
    runInTenantScope({ orgId, workspaceId }, fn);
  const dispatch = (input: unknown) =>
    scoped(() =>
      tachoCommandDispatchHandler(
        tachoCommandDispatch.input.parse(input),
        operator,
      ),
    );
  const fetch = (input: unknown) =>
    scoped(() =>
      tachoCommandFetchHandler(tachoCommandFetch.input.parse(input), machine),
    );
  const report = (runId: string) =>
    scoped(() =>
      tachoCommandListHandler(
        tachoCommandList.input.parse({ runId }),
        operator,
      ),
    );
  const rowsFor = (runId: string) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(eq(schema.tachoControlCommands.targetId, runId)),
    );

  const session = (
    key: keyof typeof sessionIds,
    over: { outcome: string; enforcementTier: string },
  ) => ({
    id: sessionIds[key],
    publicId: publicIds[key],
    orgId,
    workspaceId,
    sessionUuid: sessionUuids[key],
    harnessSessionId: `sess-${key}-${tag}`,
    hostId,
    agentKey,
    rootSessionUuid: sessionUuids[key],
    runtime: "claude-code",
    harness: "claude-code",
    startedAt: new Date("2026-09-14T09:00:00.000Z"),
    lastEventAt: new Date("2026-09-14T09:05:00.000Z"),
    ...over,
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `g2953-${tag}@handlers.test`,
        status: "active",
      });
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `G2953 ${tag}`,
        slug: `g2953-${tag}`,
        namespace: `g${tag.slice(0, 5)}`,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values({
        id: workspaceId,
        orgId,
        name: "Core",
        slug: "core",
        namespace: "core",
      });
      // The Owner role the handler's gate resolves for the operator.
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
      if (!principal || !role)
        throw new Error("fixture insert returned no row");
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal.id,
        roleId: role.id,
        orgId,
      });
      // The enrolled host behind the machine context's API key.
      await tx.insert(schema.apiKeys).values({
        id: apiKeyId,
        orgId,
        workspaceId,
        keyPrefix: `oxk_${tag}`,
        keyHash: `hash-${tag}`,
        name: `tacho host ${tag}`,
        scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
        createdByUserId: userId,
      });
      await tx.insert(schema.tachoHosts).values({
        id: hostId,
        publicId: hostPublicId,
        orgId,
        workspaceId,
        agentKey,
        apiKeyId,
        hostname: "laptop",
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
      });
      await tx.insert(schema.tachoSessions).values([
        session("live", { outcome: "running", enforcementTier: "harness" }),
        session("observe", {
          outcome: "running",
          enforcementTier: "observe",
        }),
        session("sealed", {
          outcome: "completed",
          enforcementTier: "harness",
        }),
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.tachoControlCommands)
        .where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx
        .delete(schema.tachoSessions)
        .where(eq(schema.tachoSessions.orgId, orgId));
      await tx
        .delete(schema.tachoHosts)
        .where(eq(schema.tachoHosts.id, hostId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.id, apiKeyId));
      await tx
        .delete(schema.principalRoleAssignments)
        .where(eq(schema.principalRoleAssignments.orgId, orgId));
      await tx
        .delete(schema.principals)
        .where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [userId]));
    });
    await closeDatabase();
  });

  it("queues, supersedes, sends, acknowledges, expires and reports", async () => {
    // 1. A broadcast: the live harness run is queued with interrupt degraded,
    //    the observe run is recorded failed, the sealed run is not reached.
    const first = await dispatch({
      target: { kind: "workspace", id: workspaceId },
      command: "steer",
      payload: { text: "use staging", requestedMode: "interrupt" },
    });
    expect(first.commandIds).toHaveLength(2);
    const liveRows = await rowsFor(publicIds.live);
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).toMatchObject({
      hostId,
      sessionId: sessionIds.live,
      targetKind: "run",
      command: "steer",
      outcome: "queued",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
      payload: {
        address: "@agents",
        session_uuid: sessionUuids.live,
        text: "use staging",
      },
    });
    const observeRows = await rowsFor(publicIds.observe);
    expect(observeRows[0]).toMatchObject({
      outcome: "failed",
      outcomeDetail: "observe_tier",
      deliveryMode: null,
    });
    expect(await rowsFor(publicIds.sealed)).toEqual([]);

    // 2. A pause on the same run is a different command: the queued steer
    //    stays. A second steer supersedes the first steer only.
    await dispatch({
      target: { kind: "run", id: publicIds.live },
      command: "pause",
      reason: "review the plan",
    });
    const second = await dispatch({
      target: { kind: "run", id: publicIds.live },
      command: "steer",
      payload: { text: "use production read replica" },
    });
    const afterSupersede = await rowsFor(publicIds.live);
    const byId = new Map(afterSupersede.map((r) => [r.publicId, r]));
    expect(byId.get(first.commandIds[0] ?? "")).toMatchObject({
      outcome: "cancelled",
      outcomeDetail: `superseded_by:${second.commandIds[0]}`,
    });
    expect(
      afterSupersede
        .filter((r) => r.outcome === "queued")
        .map((r) => r.command),
    ).toEqual(["pause", "steer"]);

    // 3. The host polls: the two queued rows leave as `sent`, in issue order,
    //    each carrying its modes; the failed observe row never leaves.
    const poll = await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
    });
    expect(
      poll.control.commands.map((c) => [c.command, c.delivery_mode]),
    ).toEqual([
      ["pause", null],
      ["steer", "next_step"],
    ]);
    const sent = await rowsFor(publicIds.live);
    expect(sent.filter((r) => r.outcome === "sent")).toHaveLength(2);
    expect(
      sent.every((r) => r.outcome !== "sent" || r.deliveredAt !== null),
    ).toBe(true);

    // 4. An acknowledgement lands on the sent steer; one aimed at the
    //    cancelled steer changes nothing and is not counted.
    const steerId = second.commandIds[0] ?? "";
    const cancelledId = first.commandIds[0] ?? "";
    const acked = await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
      acknowledgements: [
        { command_id: steerId, status: "applied", applied_at_seq: 17 },
        { command_id: cancelledId, status: "applied", applied_at_seq: 18 },
      ],
    });
    expect(acked.acknowledged).toBe(1);
    const afterAck = new Map(
      (await rowsFor(publicIds.live)).map((r) => [r.publicId, r]),
    );
    expect(afterAck.get(steerId)).toMatchObject({
      outcome: "applied",
      appliedAtSeq: 17,
    });
    expect(afterAck.get(steerId)?.appliedAt).not.toBeNull();
    expect(afterAck.get(cancelledId)).toMatchObject({
      outcome: "cancelled",
      appliedAtSeq: null,
    });

    // 5. Expiry: the sent pause is backdated past its expiry; the next poll
    //    marks it expired, and the report reads the same before the poll.
    await withSystemDb((tx) =>
      tx
        .update(schema.tachoControlCommands)
        .set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") })
        .where(eq(schema.tachoControlCommands.targetId, publicIds.live)),
    );
    const before = await report(publicIds.live);
    const pauseBefore = before.commands.find((c) => c.command === "pause");
    expect(pauseBefore?.status).toBe("expired");
    expect(before.commands.find((c) => c.id === steerId)?.status).toBe(
      "applied",
    );
    await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
    });
    const pauseRow = (await rowsFor(publicIds.live)).find(
      (r) => r.command === "pause",
    );
    expect(pauseRow?.outcome).toBe("expired");

    // 6. The report, newest first, with the achieved mode and the frame.
    const final = await report(publicIds.live);
    expect(final.commands.map((c) => c.command)).toEqual([
      "steer",
      "pause",
      "steer",
    ]);
    expect(final.commands[0]).toMatchObject({
      id: steerId,
      status: "applied",
      requestedMode: "next_step",
      deliveryMode: "next_step",
      appliedAtSeq: 17,
    });
    expect(final.commands[2]).toMatchObject({
      id: cancelledId,
      status: "cancelled",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
    expect((await report(publicIds.observe)).commands[0]).toMatchObject({
      status: "failed",
      detail: "observe_tier",
    });
  });
});
