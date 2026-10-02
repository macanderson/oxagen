// The send-back ports against a real Postgres (R3, #5108):
//
//   - resolve: a GitHub work item resolves through the work intake stores to
//     its collector, its connection, and the issue at GitHub. A work item a
//     person entered resolves to no collector.
//   - today: the collector row reads every write-back switch off (ADR-250),
//     so the note's outcome is off, and with send_note on it is unsupported,
//     because the GitHub module has no write-back yet. Neither records a note
//     or mints a token.
//   - record: with a module that writes notes, work.send_backs holds one row
//     per streak, a later pass posts nothing, and a new streak gets its own
//     row. Each workspace reads only its own rows, and a row never changes.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, schema, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  type AnyCollectorDefinition,
  getCollector,
  registerCollectorModules,
  sendBackWorkOrders,
  WRITE_BACK_DEFAULTS,
  type WorkOrderToSendBack,
  type WriteBackTarget,
} from "@oxagen/ingestion/collectors";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";

vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: vi.fn(async () => "ghs_sendbackinstallationtoken"),
}));

const { resolveGitHubToken } = await import("@oxagen/github/workspace-token");
const { sendBackPorts } = await import("./send-back");
const { setCollector } = await import("./collectors");

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The send-back ports test needs DATABASE_URL on CI.");

describe.skipIf(!enabled)("send-back ports against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const other = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const AMARA = crypto.randomUUID();
  const providerId = `issue:node:I_kwR3${tag}`;
  const runId = (name: string) => `tse_r3${tag}${name}`;
  let connectionId = "";
  let collectorId = "";
  let providerItemId = "";
  let manualItemId = "";
  let orderId = "";
  let orderPublicId = "";

  const inScope = <T>(fn: () => Promise<T>, s = scope): Promise<T> => runInTenantScope(s, fn);

  /** The send whose runs, newest first, each ended with nothing kept. */
  function send(itemId: string, ...names: string[]): WorkOrderToSendBack {
    return {
      orderId,
      orderPublicId,
      itemId,
      agentKey: "acme.core.builder",
      runs: names.map((name) => ({
        runId: runId(name),
        reason: "closed_unmerged" as const,
        cost: { micros: 1_250_000n, currency: "USD" },
      })),
    };
  }

  /** The GitHub module with a note writer, as #4775's Phase 2 would give it. */
  function writingModule() {
    registerCollectorModules();
    const github = getCollector("github");
    if (github === undefined) throw new Error("The GitHub collector module is not registered.");
    const notes: Array<{ target: WriteBackTarget; text: string }> = [];
    const refuse = async () => {
      throw new Error("A send-back writes a note and nothing else.");
    };
    const definition: AnyCollectorDefinition = {
      ...github,
      writeBack: {
        note: async (target, text) => {
          notes.push({ target, text });
        },
        status: refuse,
        close: refuse,
        labels: refuse,
      },
    };
    return { definition, notes };
  }

  async function sendBackRows() {
    return withSystemDb((tx) =>
      tx
        .select({ orderId: schema.workSendBacks.orderId, lastRunId: schema.workSendBacks.lastRunId })
        .from(schema.workSendBacks)
        .where(eq(schema.workSendBacks.orgId, scope.orgId))
        .orderBy(schema.workSendBacks.lastRunId),
    );
  }

  beforeAll(async () => {
    await inScope(() =>
      withTenantDb(async (tx) => {
        const [connection] = await tx
          .insert(schema.sourceConnections)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            connectorId: "github",
            displayName: "GitHub",
            authScheme: "github_app",
            deliveryMethod: "webhook",
            status: "connected",
            deliveryConfig: { installationId: 4242, owner: "acme", repo: "app" },
          })
          .returning({ id: schema.sourceConnections.id, publicId: schema.sourceConnections.publicId });
        connectionId = connection!.id;
        const set = await setCollector(tx, scope, {
          name: "github",
          connectionId: connection!.publicId,
          repos: ["acme/app"],
          actorUserId: AMARA,
        });
        collectorId = set.collectorId;

        const [providerItem] = await tx
          .insert(schema.workItems)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            number: `R3-${tag}-1`,
            subject: "Invite links expire after one hour",
            origin: "provider",
            providerId,
            collectorId,
            sourceRepository: "acme/app",
          })
          .returning({ id: schema.workItems.id });
        providerItemId = providerItem!.id;
        const [manualItem] = await tx
          .insert(schema.workItems)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            number: `R3-${tag}-2`,
            subject: "Write the release notes",
            origin: "manual",
          })
          .returning({ id: schema.workItems.id });
        manualItemId = manualItem!.id;

        const digest = `sha256:${"c".repeat(64)}`;
        const [brief] = await tx
          .insert(schema.workBriefs)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            itemId: providerItemId,
            revision: 1,
            itemRevision: 1,
            body: {},
            digest,
            author: "triage",
          })
          .returning({ id: schema.workBriefs.id });
        const [order] = await tx
          .insert(schema.workOrders)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            itemId: providerItemId,
            itemRevision: 1,
            send: 1,
            briefId: brief!.id,
            briefRevision: 1,
            briefDigest: digest,
            idempotencyKey: `${providerItemId}:r1:s1`,
            agentId: crypto.randomUUID(),
            runtimeId: crypto.randomUUID(),
            runtimeTier: "gateway",
            operatorId: AMARA,
            repository: "acme/app",
          })
          .returning({ id: schema.workOrders.id, publicId: schema.workOrders.publicId });
        orderId = order!.id;
        orderPublicId = order!.publicId;
      }),
    );
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const s = schema;
      // Each row names the one before it, so delete in this order.
      await tx.delete(s.workSendBacks).where(eq(s.workSendBacks.orgId, scope.orgId));
      await tx.delete(s.workOrders).where(eq(s.workOrders.orgId, scope.orgId));
      await tx.delete(s.workBriefs).where(eq(s.workBriefs.orgId, scope.orgId));
      await tx.delete(s.workItemFacts).where(eq(s.workItemFacts.orgId, scope.orgId));
      await tx.delete(s.workItems).where(eq(s.workItems.orgId, scope.orgId));
      await tx.delete(s.workInboundEvents).where(eq(s.workInboundEvents.orgId, scope.orgId));
      await tx.delete(s.workCollectors).where(eq(s.workCollectors.orgId, scope.orgId));
      await tx.delete(s.sourceConnections).where(eq(s.sourceConnections.orgId, scope.orgId));
    });
    await closeDatabase();
  });

  it("resolves a GitHub work item to its collector, its connection, and the issue at GitHub", async () => {
    const resolved = await inScope(() => sendBackPorts(scope).resolve(providerItemId));
    expect(resolved).not.toBeNull();
    expect(resolved!.collector.definition.type).toBe("github");
    expect(resolved!.collector.health).toBe("healthy");
    // The collector row mirrors a collector/v1 document with every switch off.
    expect(resolved!.collector.switches).toEqual({
      certify_note: false,
      send_note: false,
      status: false,
      close: false,
      labels: false,
    });
    expect(resolved!.target.ref).toEqual({ providerId });
    expect(resolved!.target.conn.id).toBe(connectionId);
    // No note can be written, so no token is minted.
    expect(resolved!.target.conn.auth).toEqual({ scheme: "public" });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it("resolves a work item a person entered, one the workspace does not hold, or one with no module to no collector", async () => {
    await expect(inScope(() => sendBackPorts(scope).resolve(manualItemId))).resolves.toBeNull();
    await expect(inScope(() => sendBackPorts(scope).resolve(crypto.randomUUID()))).resolves.toBeNull();
    // A collector whose type has no registered module has nothing to write with.
    const noModule = sendBackPorts(scope, { definition: () => undefined });
    await expect(inScope(() => noModule.resolve(providerItemId))).resolves.toBeNull();
    const results = await inScope(() => sendBackWorkOrders([send(manualItemId, "c", "b", "a")], sendBackPorts(scope)));
    expect(results).toEqual([{ orderId, outcome: "no_collector" }]);
  });

  it("posts nothing on a GitHub work item today: the switch reads off, and GitHub has no write-back", async () => {
    const off = await inScope(() => sendBackWorkOrders([send(providerItemId, "c", "b", "a")], sendBackPorts(scope)));
    expect(off).toEqual([{ orderId, outcome: "off" }]);

    const switchedOn = sendBackPorts(scope, { switches: () => ({ ...WRITE_BACK_DEFAULTS }) });
    const unsupported = await inScope(() => sendBackWorkOrders([send(providerItemId, "c", "b", "a")], switchedOn));
    expect(unsupported).toEqual([{ orderId, outcome: "unsupported" }]);

    expect(await sendBackRows()).toEqual([]);
    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it("records one row per streak once a note is written, so a later pass posts nothing", async () => {
    const writer = writingModule();
    const ports = sendBackPorts(scope, {
      switches: () => ({ ...WRITE_BACK_DEFAULTS }),
      definition: () => writer.definition,
    });

    const first = await inScope(() => sendBackWorkOrders([send(providerItemId, "c", "b", "a")], ports));
    expect(first).toEqual([{ orderId, outcome: "written" }]);
    expect(writer.notes).toHaveLength(1);
    expect(writer.notes[0]!.target).toEqual({
      ref: { providerId },
      conn: { id: connectionId, auth: { scheme: "bearer_token", token: "ghs_sendbackinstallationtoken" } },
    });
    expect(writer.notes[0]!.text).toContain(`Oxagen sent work order ${orderPublicId} back to this work item.`);
    expect(writer.notes[0]!.text).toContain("Unproductive spend: $3.75 across 3 runs.");
    expect(resolveGitHubToken).toHaveBeenCalledTimes(1);
    expect(resolveGitHubToken).toHaveBeenCalledWith({ ...scope, connectionId });
    expect(await sendBackRows()).toEqual([{ orderId, lastRunId: runId("c") }]);

    for (let i = 0; i < 2; i += 1) {
      const again = await inScope(() => sendBackWorkOrders([send(providerItemId, "c", "b", "a")], ports));
      expect(again).toEqual([{ orderId, outcome: "already_sent" }]);
    }
    expect(writer.notes).toHaveLength(1);

    // A second add of the same streak changes nothing.
    await inScope(() => ports.record.add({ orderId, lastRunId: runId("c") }));
    expect(await sendBackRows()).toEqual([{ orderId, lastRunId: runId("c") }]);

    const second = await inScope(() => sendBackWorkOrders([send(providerItemId, "f", "e", "d")], ports));
    expect(second).toEqual([{ orderId, outcome: "written" }]);
    expect(writer.notes).toHaveLength(2);
    expect(await sendBackRows()).toEqual([
      { orderId, lastRunId: runId("c") },
      { orderId, lastRunId: runId("f") },
    ]);
  });

  it("reads each workspace's notes only", async () => {
    const key = { orderId, lastRunId: runId("k") };
    await inScope(() => sendBackPorts(scope).record.add(key));
    await expect(inScope(() => sendBackPorts(scope).record.has(key))).resolves.toBe(true);
    await expect(inScope(() => sendBackPorts(other).record.has(key), other)).resolves.toBe(false);
  });

  it("never changes a posted note", async () => {
    const key = { orderId, lastRunId: runId("m") };
    await inScope(() => sendBackPorts(scope).record.add(key));
    await expect(
      withSystemDb((tx) =>
        tx
          .update(schema.workSendBacks)
          .set({ lastRunId: runId("z") })
          .where(eq(schema.workSendBacks.lastRunId, key.lastRunId)),
      ),
    ).rejects.toThrow();
    await expect(inScope(() => sendBackPorts(scope).record.has(key))).resolves.toBe(true);
    await expect(inScope(() => sendBackPorts(scope).record.has({ orderId, lastRunId: runId("z") }))).resolves.toBe(false);
  });
});
