// Command delivery against a real Postgres: a `sent` command the host never
// acknowledged is offered again once its lease runs out, and never while the
// lease holds or after any acknowledgement; acknowledgements only move a row
// forward; a `sent` row left unacknowledged past its expiry and the grace is
// swept `expired`; two drains for one host at once deliver a command once;
// and a value Postgres cannot store maps to a refused input. Runs wherever
// DATABASE_URL points at a migrated database (CI's `test` job); a local run
// without one is skipped, not red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, sql } from "drizzle-orm";
import {
  COMMAND_ACK_GRACE_MS,
  COMMAND_REDELIVERY_LEASE_MS,
  type TachoHostRow,
  drainCommands,
  unstorableBatch,
} from "./lib/tacho-host";
import { tachoCommandFetchHandler } from "./tacho.command.fetch";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("command delivery against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const hostPublicId = `tch_${tag}00000000000000`;
  let seq = 0;

  const machine: CapabilityContext = {
    orgId,
    workspaceId,
    userId: null,
    apiKeyId,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  };
  const fetch = (acknowledgements: unknown[] = []) =>
    runInTenantScope({ orgId, workspaceId }, () =>
      tachoCommandFetchHandler(
        tachoCommandFetch.input.parse({
          schema: "tacho.commands.v2",
          host_enrollment_id: hostPublicId,
          acknowledgements,
        }),
        machine,
      ),
    );
  const ago = (ms: number) => new Date(Date.now() - ms);

  /** One host-level command row, queued unless the case says otherwise. */
  async function command(
    over: Partial<typeof schema.tachoControlCommands.$inferInsert> = {},
  ): Promise<string> {
    seq += 1;
    const publicId = `tcm_${tag}${String(seq).padStart(14, "0")}`;
    await withSystemDb((tx) =>
      tx.insert(schema.tachoControlCommands).values({
        publicId,
        orgId,
        workspaceId,
        hostId,
        targetKind: "host",
        targetId: hostPublicId,
        command: "refresh_bundle",
        issuedAt: ago(10 * 60_000 - seq),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        ...over,
      }),
    );
    return publicId;
  }
  const row = async (publicId: string) => {
    const [found] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(eq(schema.tachoControlCommands.publicId, publicId)),
    );
    if (!found) throw new Error(`no command ${publicId}`);
    return found;
  };
  const setRow = (
    publicId: string,
    values: Partial<typeof schema.tachoControlCommands.$inferInsert>,
  ) =>
    withSystemDb((tx) =>
      tx
        .update(schema.tachoControlCommands)
        .set(values)
        .where(eq(schema.tachoControlCommands.publicId, publicId)),
    );
  /** Settle every open row, so each case starts from an empty queue. */
  const settleAll = () =>
    withSystemDb((tx) =>
      tx
        .update(schema.tachoControlCommands)
        .set({ outcome: "cancelled" })
        .where(eq(schema.tachoControlCommands.hostId, hostId)),
    );

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `cmd-lease-${tag}@handlers.test`,
        status: "active",
      });
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Lease ${tag}`,
        slug: `lease-${tag}`,
        namespace: `l${tag.slice(0, 5)}`,
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
        agentKey: `lease.core.bot-${tag}`,
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
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        status: "active",
        mode: "enforce",
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.tachoControlCommands)
        .where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx
        .delete(schema.tachoHosts)
        .where(eq(schema.tachoHosts.id, hostId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.id, apiKeyId));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("offers a sent command again once its lease runs out, and never after an acknowledgement", async () => {
    await settleAll();
    const id = await command();

    const first = await fetch();
    expect(first.control.commands.map((c) => c.id)).toEqual([id]);
    expect(await row(id)).toMatchObject({ outcome: "sent" });

    // The response is lost. Within the lease the row is not offered again.
    const within = await fetch();
    expect(within.control.commands).toEqual([]);

    // Past the lease with no acknowledgement, it is, and the lease restarts.
    const lapsed = ago(COMMAND_REDELIVERY_LEASE_MS + 1_000);
    await setRow(id, { deliveredAt: lapsed });
    const again = await fetch();
    expect(again.control.commands.map((c) => c.id)).toEqual([id]);
    const redelivered = await row(id);
    expect(redelivered.outcome).toBe("sent");
    expect(redelivered.deliveredAt?.getTime()).toBeGreaterThan(
      lapsed.getTime(),
    );

    // Any acknowledgement takes the row out of the lease for good.
    const acked = await fetch([{ command_id: id, status: "received" }]);
    expect(acked.acknowledged).toBe(1);
    expect(acked.control.commands).toEqual([]);
    await setRow(id, { deliveredAt: lapsed });
    const later = await fetch();
    expect(later.control.commands).toEqual([]);
    expect(await row(id)).toMatchObject({ outcome: "received" });
  });

  it("moves a row forward only: a late received does not pull an acknowledged row back", async () => {
    await settleAll();
    const id = await command({
      outcome: "acknowledged",
      deliveredAt: ago(5_000),
      acknowledgedAt: ago(4_000),
    });

    const late = await fetch([{ command_id: id, status: "received" }]);
    expect(late.acknowledged).toBe(0);
    expect(await row(id)).toMatchObject({ outcome: "acknowledged" });

    // The same status again is a re-send and lands.
    const resent = await fetch([{ command_id: id, status: "acknowledged" }]);
    expect(resent.acknowledged).toBe(1);

    const applied = await fetch([
      { command_id: id, status: "applied", applied_at_seq: 5 },
    ]);
    expect(applied.acknowledged).toBe(1);
    expect(await row(id)).toMatchObject({
      outcome: "applied",
      appliedAtSeq: 5,
    });

    // Terminal is terminal.
    const after = await fetch([{ command_id: id, status: "failed" }]);
    expect(after.acknowledged).toBe(0);
    expect(await row(id)).toMatchObject({ outcome: "applied" });
  });

  it("sweeps a sent row the host never acknowledged once the grace after its expiry has passed", async () => {
    await settleAll();
    const stale = await command({
      outcome: "sent",
      expiresAt: ago(COMMAND_ACK_GRACE_MS + 60_000),
      deliveredAt: ago(COMMAND_ACK_GRACE_MS + 120_000),
    });
    const inGrace = await command({
      outcome: "sent",
      expiresAt: ago(60_000),
      deliveredAt: ago(120_000),
    });
    const received = await command({
      outcome: "received",
      expiresAt: ago(COMMAND_ACK_GRACE_MS + 60_000),
      deliveredAt: ago(COMMAND_ACK_GRACE_MS + 120_000),
    });

    const poll = await fetch();
    // None is offered: each one's expiry has passed.
    expect(poll.control.commands).toEqual([]);
    expect(await row(stale)).toMatchObject({ outcome: "expired" });
    expect(await row(inGrace)).toMatchObject({ outcome: "sent" });
    expect(await row(received)).toMatchObject({ outcome: "received" });

    // Inside the grace the host's own answer still lands.
    const answered = await fetch([
      { command_id: inGrace, status: "applied", applied_at_seq: 9 },
    ]);
    expect(answered.acknowledged).toBe(1);
  });

  it("delivers a command once when two drains for one host overlap", async () => {
    await settleAll();
    const id = await command();
    const [host] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoHosts)
        .where(eq(schema.tachoHosts.id, hostId)),
    );
    if (!host) throw new Error("fixture host missing");

    // The first drain holds its transaction open after marking the row, the
    // way an ingest does while it finishes its batch; the second starts in
    // that window.
    let signalDrained: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
    const first = withSystemDb(async (tx) => {
      const commands = await drainCommands(tx as never, host as TachoHostRow);
      signalDrained();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return commands;
    });
    await drained;
    const second = withSystemDb((tx) =>
      drainCommands(tx as never, host as TachoHostRow),
    );
    const [a, b] = await Promise.all([first, second]);
    expect([...a, ...b].map((c) => c.id)).toEqual([id]);
    expect(a.map((c) => c.id)).toEqual([id]);
  });

  it("maps a value Postgres cannot store to a refused input", async () => {
    const err = await withSystemDb((tx) =>
      tx.execute(sql`SELECT ${4_294_967_295}::integer`),
    ).catch((e: unknown) => e);
    const refusal = unstorableBatch("ingest_tacho_events", err);
    expect(refusal?.code).toBe("invalid_input");
    expect(refusal?.message).toContain("SQLSTATE 22003");
  });
});
