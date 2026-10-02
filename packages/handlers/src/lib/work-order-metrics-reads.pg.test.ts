// The work order metrics reads against a real Postgres (F33, #5087):
//   - a run on a direct work order attached 23 hours after its first run
//     reads as assigned from that run, and one attached at 25 hours reads as
//     assigned from the attachment on (decision 4)
//   - a send's run reads as assigned, with its work item's definition of done
//   - a send reads with its operator's principal, its agent's key, its check
//     runs, the reopen of its work item, and its runs
//   - another workspace's rows stay out
//
// Runs wherever DATABASE_URL points at a migrated database (CI's unit lane
// migrates Postgres first). On CI a missing DATABASE_URL fails the file
// instead of skipping it. Every row it writes is removed in afterAll.
import { assignedFrom } from "@oxagen/billing";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMetricOrders, readMetricRuns } from "./work-order-metrics-reads";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled)
  throw new Error("The work order metrics reads test needs DATABASE_URL on CI.");

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

describe.skipIf(!enabled)("the work order metrics reads against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const orgId = crypto.randomUUID();
  const namespace = () =>
    `m${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  const orgNamespace = namespace();
  const wsNamespace = namespace();
  const operatorUser = crypto.randomUUID();
  const runId = (name: string) => `tse_f33${tag}${name}`;
  const week = {
    start: at("2026-09-28T00:00:00.000Z"),
    end: at("2026-10-05T00:00:00.000Z"),
  };
  const digest = `sha256:${"b".repeat(64)}`;
  let workspaceId = "";
  let otherWorkspaceId = "";
  let operatorKey = "";
  let orderId = "";
  let orderPublicId = "";

  const scope = () => ({ orgId, workspaceId });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Work order metrics ${tag}`,
        slug: `f33-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
      const [ws, other] = await tx
        .insert(schema.workspaces)
        .values([
          { orgId, name: "core", slug: `core-${tag}`, namespace: wsNamespace },
          { orgId, name: "lab", slug: `lab-${tag}`, namespace: namespace() },
        ])
        .returning({ id: schema.workspaces.id });
      workspaceId = ws!.id;
      otherWorkspaceId = other!.id;
      const [human, agentPrincipal] = await tx
        .insert(schema.principals)
        .values([
          {
            orgId,
            kind: "human",
            displayName: "Ana",
            parentUserId: operatorUser,
          },
          { orgId, workspaceId, kind: "agent", displayName: "builder" },
        ])
        .returning({
          id: schema.principals.id,
          publicId: schema.principals.publicId,
        });
      operatorKey = human!.publicId;
      const [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId,
          workspaceId,
          slug: "builder",
          name: "builder",
          agentType: "custom",
          principalId: agentPrincipal!.id,
        })
        .returning({ id: schema.agents.id });
      const [item] = await tx
        .insert(schema.workItems)
        .values({
          orgId,
          workspaceId,
          number: `F33-${tag}`,
          subject: "Fix invites",
          origin: "manual",
        })
        .returning({ id: schema.workItems.id });
      const itemId = item!.id;
      await tx.insert(schema.workDoneRecords).values({
        orgId,
        workspaceId,
        digest,
        itemId,
        body: {},
        lockedBy: operatorUser,
        lockedAt: at("2026-09-28T07:00:00.000Z"),
      });
      const [brief] = await tx
        .insert(schema.workBriefs)
        .values({
          orgId,
          workspaceId,
          itemId,
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
          orgId,
          workspaceId,
          createdAt: at("2026-09-29T08:00:00.000Z"),
          itemId,
          itemRevision: 1,
          send: 1,
          briefId: brief!.id,
          briefRevision: 1,
          briefDigest: digest,
          idempotencyKey: `${itemId}:r1:s1`,
          agentId: agent!.id,
          runtimeId: crypto.randomUUID(),
          runtimeTier: "gateway",
          operatorId: operatorUser,
          repository: "acme/app",
          releasedAt: at("2026-09-30T00:00:00.000Z"),
          closedAt: at("2026-09-30T00:00:00.000Z"),
        })
        .returning({
          id: schema.workOrders.id,
          publicId: schema.workOrders.publicId,
        });
      orderId = order!.id;
      orderPublicId = order!.publicId;
      await tx.insert(schema.workDoneChecks).values([
        {
          orgId,
          workspaceId,
          orderId,
          recordDigest: digest,
          verdict: "broken",
          result: "failed",
          checkedAt: at("2026-09-29T10:00:00.000Z"),
          sessionId: "ses_fix_1",
          role: "Fix",
        },
        {
          orgId,
          workspaceId,
          orderId,
          recordDigest: digest,
          verdict: "held",
          result: "passed",
          checkedAt: at("2026-09-29T12:00:00.000Z"),
          sessionId: "ses_fix_2",
          role: "Fix",
        },
      ]);
      await tx.insert(schema.workItemFacts).values({
        orgId,
        workspaceId,
        itemId,
        kind: "reopened",
        source: "person",
        itemRevision: 1,
        actor: operatorUser,
        data: { reason: "The invite still fails on Safari." },
        occurredAt: at("2026-10-01T09:00:00.000Z"),
        dedupeKey: `reopened:${tag}`,
      });

      // Two direct work orders: one attached 23 hours after its run started,
      // one attached at 25 hours.
      const opened = at("2026-09-29T09:00:00.000Z");
      const [soon, late] = await tx
        .insert(schema.workDirectOrders)
        .values([
          {
            orgId,
            workspaceId,
            runId: runId("soon"),
            openedAt: opened,
            itemId,
            attachedAt: new Date(opened.getTime() + 23 * HOUR),
            attachedBy: operatorUser,
          },
          {
            orgId,
            workspaceId,
            runId: runId("late"),
            openedAt: opened,
            itemId,
            attachedAt: new Date(opened.getTime() + 25 * HOUR),
            attachedBy: operatorUser,
          },
        ])
        .returning({ id: schema.workDirectOrders.id });

      const totals = (
        name: string,
        workOrderId: string | null,
        kind: "send" | "direct" | null,
        cost: bigint,
        ws = workspaceId,
      ) => ({
        orgId,
        workspaceId: ws,
        runId: runId(name),
        runSource: "tacho",
        operatorKey,
        agentKey: `${orgNamespace}.${wsNamespace}.builder`,
        startedAt: opened,
        sealedAt: at("2026-09-29T10:00:00.000Z"),
        steps: 1,
        modelCalls: 1,
        toolCalls: 0,
        tokens: { input_uncached: 100, output: 20, server_tool_request: 3 },
        costMicros: cost,
        costBasis: "gateway_observed",
        currency: "USD",
        breakdown: { models: [], tools: [] },
        rolledUpAt: at("2026-09-29T10:05:00.000Z"),
        workOrderId,
        workOrderKind: kind,
      });
      await tx
        .insert(schema.runTotals)
        .values([
          totals("send", orderId, "send", 400n),
          totals("soon", soon!.id, "direct", 300n),
          totals("late", late!.id, "direct", 200n),
          totals("old", null, null, 100n),
          totals("lab", null, null, 999n, otherWorkspaceId),
        ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.runTotals).where(eq(schema.runTotals.orgId, orgId));
      await tx
        .delete(schema.workDoneChecks)
        .where(eq(schema.workDoneChecks.orgId, orgId));
      await tx
        .delete(schema.workItemFacts)
        .where(eq(schema.workItemFacts.orgId, orgId));
      await tx
        .delete(schema.workDirectOrders)
        .where(eq(schema.workDirectOrders.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx
        .delete(schema.workDoneRecords)
        .where(eq(schema.workDoneRecords.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
    });
    await closeDatabase();
  });

  it("reads each run with how its work order is assigned, by the 24-hour grace window", async () => {
    const runs = await runInTenantScope(scope(), () =>
      readMetricRuns(scope(), week, null),
    );
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect([...byId.keys()].sort()).toEqual(
      [runId("late"), runId("old"), runId("send"), runId("soon")].sort(),
    );
    const opened = at("2026-09-29T09:00:00.000Z");
    // Attached at 23 hours: assigned from the run's start.
    expect(byId.get(runId("soon"))?.assignment).toEqual({
      kind: "direct",
      from: opened,
    });
    // Attached at 25 hours: assigned from the attachment on.
    expect(byId.get(runId("late"))?.assignment).toEqual({
      kind: "direct",
      from: new Date(opened.getTime() + 25 * HOUR),
    });
    expect(byId.get(runId("late"))?.assignment).toEqual({
      kind: "direct",
      from: assignedFrom({
        openedAt: opened,
        attachedAt: new Date(opened.getTime() + 25 * HOUR),
      }),
    });
    expect(byId.get(runId("send"))).toMatchObject({
      assignment: { kind: "send" },
      definitionOfDone: true,
      costMicros: 400n,
      currency: "USD",
      // Every token class but server tool requests.
      tokens: 120,
      operatorKey,
      lastFrameAt: at("2026-09-29T10:00:00.000Z"),
    });
    expect(byId.get(runId("old"))?.assignment).toEqual({
      kind: "not_recorded",
    });
    expect(byId.get(runId("soon"))?.definitionOfDone).toBe(false);
  });

  it("reads only the named operators' runs when asked", async () => {
    expect(
      await runInTenantScope(scope(), () =>
        readMetricRuns(scope(), week, ["prn_nobody"]),
      ),
    ).toEqual([]);
    expect(
      await runInTenantScope(scope(), () => readMetricRuns(scope(), week, [])),
    ).toEqual([]);
  });

  it("reads a send with its operator, agent, check runs, reopen, and runs", async () => {
    const orders = await runInTenantScope(scope(), () =>
      readMetricOrders(scope(), week),
    );
    expect(orders).toHaveLength(1);
    const [order] = orders;
    expect(order).toMatchObject({
      id: orderId,
      publicId: orderPublicId,
      operatorKey,
      agentKey: `${orgNamespace}.${wsNamespace}.builder`,
      dispatchedAt: at("2026-09-29T08:00:00.000Z"),
      closedAt: at("2026-09-30T00:00:00.000Z"),
      definitionOfDone: true,
      rejections: [at("2026-10-01T09:00:00.000Z")],
    });
    expect(
      [...(order?.checks ?? [])].sort(
        (a, b) => a.checkedAt.getTime() - b.checkedAt.getTime(),
      ),
    ).toEqual([
      { checkedAt: at("2026-09-29T10:00:00.000Z"), result: "failed" },
      { checkedAt: at("2026-09-29T12:00:00.000Z"), result: "passed" },
    ]);
    expect(order?.runs).toEqual([
      {
        runId: runId("send"),
        startedAt: at("2026-09-29T09:00:00.000Z"),
        costMicros: 400n,
        currency: "USD",
      },
    ]);
  });

  it("reads nothing from another workspace", async () => {
    const lab = { orgId, workspaceId: otherWorkspaceId };
    expect(
      await runInTenantScope(lab, () => readMetricOrders(lab, week)),
    ).toEqual([]);
    const runs = await runInTenantScope(lab, () =>
      readMetricRuns(lab, week, null),
    );
    expect(runs.map((r) => r.runId)).toEqual([runId("lab")]);
  });

  it("reads no send outside the range", async () => {
    const later = {
      start: at("2026-10-12T00:00:00.000Z"),
      end: at("2026-10-19T00:00:00.000Z"),
    };
    expect(
      await runInTenantScope(scope(), () => readMetricOrders(scope(), later)),
    ).toEqual([]);
  });
});
