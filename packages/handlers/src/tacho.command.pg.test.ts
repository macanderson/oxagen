// The run-control path against a real Postgres: dispatch_command writes one
// row per recipient with the resolved mode, supersedes the earlier queued
// steer and no other row, fetch_commands expires the queued rows the clock
// passed and drains the rest as sent with their modes, an acknowledgement
// lands on an open row (a sent one past its expiry included) and never on a
// terminal one, and list_commands reads it all back with `expired` derived. Runs wherever DATABASE_URL points at a migrated
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
import { asc, eq, inArray } from "drizzle-orm";
import {
  BUNDLE_FEATURE_STEER_NEXT_STEP,
  tachoCommandDispatchHandler,
} from "./tacho.command.dispatch";
import { tachoCommandFetchHandler } from "./tacho.command.fetch";
import { tachoCommandListHandler } from "./tacho.command.list";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("run controls against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  // A second workspace in the same organization, whose command a read by
  // command ids must leave out.
  const otherWorkspaceId = crypto.randomUUID();
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
  const reportByIds = (commandIds: string[]) =>
    scoped(() =>
      tachoCommandListHandler(
        tachoCommandList.input.parse({ commandIds }),
        operator,
      ),
    );
  // Ordered, because the walk below asserts issue order off it. An unordered
  // SELECT returns rows in heap order, which is not insertion order — the
  // supersede UPDATE rewrites a row and moves it — so the assertion passed by
  // luck until it did not. Same total order the host poll and `list_commands`
  // use: the issue instant, then the public id to break a tie.
  const rowsFor = (runId: string) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(eq(schema.tachoControlCommands.targetId, runId))
        .orderBy(
          asc(schema.tachoControlCommands.issuedAt),
          asc(schema.tachoControlCommands.publicId),
        ),
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
      await tx.insert(schema.workspaces).values({
        id: otherWorkspaceId,
        orgId,
        name: "Other",
        slug: "other",
        namespace: "other",
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
        createdById: userId,
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
        // A host that polled a moment ago and carries a steer to the next
        // model call, so a command can reach its runs (ADR-163).
        lastSeenAt: new Date(),
        bundleFeatures: [BUNDLE_FEATURE_STEER_NEXT_STEP],
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
        .where(inArray(schema.workspaces.id, [workspaceId, otherWorkspaceId]));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [userId]));
    });
    await closeDatabase();
  });

  it("queues, supersedes, sends, acknowledges, expires and reports", async () => {
    // 1. A broadcast: the live harness run and the observe-tier run on the
    //    same live host are both queued with interrupt degraded to the next
    //    step (the tier does not decide reach, ADR-163); the sealed run is not
    //    reached.
    const first = await dispatch({
      target: { kind: "workspace", id: workspaceId },
      command: "steer",
      payload: { text: "use staging", requestedMode: "interrupt" },
    });
    expect(first.commandIds).toHaveLength(2);
    const liveRows = await rowsFor(publicIds.live);
    expect(liveRows).toHaveLength(1);
    // The fan-out orders its recipients by start time, and both sessions
    // here start at the same instant, so the live run's command is read from
    // its own row rather than from a position in `commandIds`.
    const firstLiveId = liveRows[0]?.publicId ?? "";
    expect(first.commandIds).toContain(firstLiveId);
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
      outcome: "queued",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
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
    expect(byId.get(firstLiveId)).toMatchObject({
      outcome: "cancelled",
      outcomeDetail: `superseded_by:${second.commandIds[0]}`,
    });
    expect(
      afterSupersede
        .filter((r) => r.outcome === "queued")
        .map((r) => r.command),
    ).toEqual(["pause", "steer"]);

    // 3. The host polls: the three queued rows leave as `sent`, in issue
    //    order, each carrying its modes, the observe run's steer first.
    const poll = await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
    });
    expect(
      poll.control.commands.map((c) => [c.command, c.delivery_mode, c.reason]),
    ).toEqual([
      ["steer", "next_step", null],
      ["pause", null, "review the plan"],
      ["steer", "next_step", null],
    ]);
    const sent = await rowsFor(publicIds.live);
    expect(sent.filter((r) => r.outcome === "sent")).toHaveLength(2);
    expect(
      sent.every((r) => r.outcome !== "sent" || r.deliveredAt !== null),
    ).toBe(true);

    // 4. An acknowledgement lands on the sent steer; one aimed at the
    //    cancelled steer changes nothing and is not counted.
    const steerId = second.commandIds[0] ?? "";
    const cancelledId = firstLiveId;
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

    // 5. Expiry follows ownership. A resume is queued and every row of the
    //    run is backdated past its expiry. Before any poll the report derives
    //    `expired` for the queued resume only; the sent pause is the host's
    //    row and reads `sent` as recorded. A poll with nothing to report (the
    //    ingest that lands between the host's receipt and its next poll)
    //    sweeps the queued resume (Oxagen's row, never drained) and leaves
    //    the sent pause alone: the host applied it at receipt, acknowledges
    //    it on the poll after, past the clock, and the acknowledgement lands.
    const third = await dispatch({
      target: { kind: "run", id: publicIds.live },
      command: "resume",
    });
    const resumeId = third.commandIds[0] ?? "";
    await withSystemDb((tx) =>
      tx
        .update(schema.tachoControlCommands)
        .set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") })
        .where(eq(schema.tachoControlCommands.targetId, publicIds.live)),
    );
    const before = await report(publicIds.live);
    const statusBefore = new Map(before.commands.map((c) => [c.id, c.status]));
    expect(statusBefore.get(resumeId)).toBe("expired");
    expect(before.commands.find((c) => c.command === "pause")?.status).toBe(
      "sent",
    );
    expect(statusBefore.get(steerId)).toBe("applied");
    const pauseId =
      (await rowsFor(publicIds.live)).find((r) => r.command === "pause")
        ?.publicId ?? "";
    const swept = await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
    });
    expect(swept.control.commands).toEqual([]);
    const afterSweep = new Map(
      (await rowsFor(publicIds.live)).map((r) => [r.publicId, r]),
    );
    expect(afterSweep.get(resumeId)).toMatchObject({
      outcome: "expired",
      deliveredAt: null,
    });
    expect(afterSweep.get(pauseId)).toMatchObject({ outcome: "sent" });
    const late = await fetch({
      schema: "tacho.commands.v2",
      host_enrollment_id: hostPublicId,
      acknowledgements: [
        { command_id: pauseId, status: "applied", applied_at_seq: 21 },
      ],
    });
    expect(late.acknowledged).toBe(1);
    expect(late.control.commands).toEqual([]);
    const afterAckLate = new Map(
      (await rowsFor(publicIds.live)).map((r) => [r.publicId, r]),
    );
    expect(afterAckLate.get(pauseId)).toMatchObject({
      outcome: "applied",
      appliedAtSeq: 21,
    });
    expect(afterAckLate.get(resumeId)).toMatchObject({ outcome: "expired" });

    // 6. The report, newest first, with the achieved mode and the frame.
    const final = await report(publicIds.live);
    expect(final.commands.map((c) => c.command)).toEqual([
      "resume",
      "steer",
      "pause",
      "steer",
    ]);
    expect(final.commands[0]).toMatchObject({
      id: resumeId,
      status: "expired",
    });
    expect(final.commands[1]).toMatchObject({
      id: steerId,
      status: "applied",
      requestedMode: "next_step",
      deliveryMode: "next_step",
      appliedAtSeq: 17,
    });
    expect(final.commands[2]).toMatchObject({
      id: pauseId,
      status: "applied",
      appliedAtSeq: 21,
    });
    expect(final.commands[3]).toMatchObject({
      id: cancelledId,
      status: "cancelled",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
    expect((await report(publicIds.observe)).commands[0]).toMatchObject({
      status: "sent",
      deliveryMode: "next_step",
    });

    // 7. Each row names its run and its issuer, by public id, with the name
    //    null because the fixture's user records none. The steer quotes its
    //    text; the pause and the resume carry none.
    const [issuer] = await withSystemDb((tx) =>
      tx
        .select({ publicId: schema.users.publicId })
        .from(schema.users)
        .where(eq(schema.users.id, userId)),
    );
    expect(issuer?.publicId).toMatch(/^usr_/);
    for (const command of final.commands) {
      expect(command.runId).toBe(publicIds.live);
      expect(command.issuedBy).toEqual({ id: issuer?.publicId, name: null });
    }
    expect(final.commands.map((c) => c.text)).toEqual([
      null,
      "use production read replica",
      null,
      "use staging",
    ]);
  });

  it("reads a broadcast's rows by command id, each naming its run, and leaves out an id from another workspace (negative)", async () => {
    const broadcast = await withSystemDb((tx) =>
      tx
        .select({
          publicId: schema.tachoControlCommands.publicId,
          targetId: schema.tachoControlCommands.targetId,
        })
        .from(schema.tachoControlCommands)
        .where(
          inArray(schema.tachoControlCommands.targetId, [
            publicIds.live,
            publicIds.observe,
          ]),
        ),
    );
    const [foreign] = await withSystemDb((tx) =>
      tx
        .insert(schema.tachoControlCommands)
        .values({
          orgId,
          workspaceId: otherWorkspaceId,
          targetKind: "run",
          targetId: `tse_${tag}0000000000000x`,
          command: "pause",
          issuedByUserId: userId,
          createdById: userId,
          updatedById: userId,
        })
        .returning({ publicId: schema.tachoControlCommands.publicId }),
    );
    if (!foreign) throw new Error("fixture insert returned no row");
    const ids = [...broadcast.map((r) => r.publicId), foreign.publicId];
    const read = await reportByIds(ids);
    expect(read.commands.map((c) => c.id).sort()).toEqual(
      broadcast.map((r) => r.publicId).sort(),
    );
    const runOf = new Map(broadcast.map((r) => [r.publicId, r.targetId]));
    for (const command of read.commands)
      expect(command.runId).toBe(runOf.get(command.id));
    expect(read.commands.map((c) => c.id)).not.toContain(foreign.publicId);
  });
});
