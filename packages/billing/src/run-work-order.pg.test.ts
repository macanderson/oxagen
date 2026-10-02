// The work order a run belongs to, against a real Postgres (F13, #4638):
//   - a run a send launched carries the send, found by its run_linked fact or
//     by a frame's claim that names a send to the run's own agent
//   - a claim that names another agent's send, or another workspace's, is not
//     taken
//   - a run started outside Oxagen gets one direct work order, however often
//     the rollup sees it
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job);
// a local run without one is skipped, not red. ClickHouse is a fake that
// returns the claims each case names. Every row it writes is removed in
// afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const claims = vi.hoisted(() => ({ next: [] as string[] }));

vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  readRunWorkOrderClaims: vi.fn(async () => claims.next),
}));

import type { RunMeta } from "./cost-rollup";
import { productionRunWorkOrderDeps, resolveRunWorkOrder, type RunWorkOrderSource } from "./run-work-order";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The run work order test needs DATABASE_URL on CI.");

describe.skipIf(!enabled)("the run work order against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const orgId = crypto.randomUUID();
  const namespace = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  const runId = (name: string) => `tse_f13${tag}${name}`;
  let workspaceId = "";
  let otherWorkspaceId = "";
  let agentPrincipal = "";
  let otherPrincipal = "";
  let orderId = "";
  let orderPublicId = "";

  function source(name: string, over: Partial<RunMeta> = {}): RunWorkOrderSource {
    return {
      meta: {
        runId: runId(name),
        runSource: "tacho",
        orgId,
        workspaceId,
        operatorPrincipalId: null,
        operatorKey: null,
        agentPrincipalId: agentPrincipal,
        agentKey: null,
        taskRef: null,
        costCenter: null,
        startedAt: new Date("2026-10-01T09:00:00.000Z"),
        sealedAt: null,
        turns: null,
        retries: null,
        enforcementTier: null,
        replayGrade: null,
        ...over,
      },
      frames: { kind: "tacho", rootSessionUuid: crypto.randomUUID(), sessionUuids: [] },
    };
  }

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Work order capture ${tag}`,
        slug: `f13-${tag}`,
        namespace: namespace(),
        planType: "free",
        status: "active",
      });
      const [ws, other] = await tx
        .insert(schema.workspaces)
        .values([
          { orgId, name: "core", slug: `core-${tag}`, namespace: namespace() },
          { orgId, name: "lab", slug: `lab-${tag}`, namespace: namespace() },
        ])
        .returning({ id: schema.workspaces.id });
      workspaceId = ws!.id;
      otherWorkspaceId = other!.id;
      const principals = await tx
        .insert(schema.principals)
        .values([
          { orgId, workspaceId, kind: "agent", displayName: "builder" },
          { orgId, workspaceId, kind: "agent", displayName: "reviewer" },
        ])
        .returning({ id: schema.principals.id, displayName: schema.principals.displayName });
      agentPrincipal = principals.find((p) => p.displayName === "builder")!.id;
      otherPrincipal = principals.find((p) => p.displayName === "reviewer")!.id;
      const [agent] = await tx
        .insert(schema.agents)
        .values({ orgId, workspaceId, slug: "builder", name: "builder", agentType: "custom", principalId: agentPrincipal })
        .returning({ id: schema.agents.id });
      const [item] = await tx
        .insert(schema.workItems)
        .values({ orgId, workspaceId, number: `F13-${tag}`, subject: "Fix invites", origin: "manual" })
        .returning({ id: schema.workItems.id });
      const digest = `sha256:${"a".repeat(64)}`;
      const [brief] = await tx
        .insert(schema.workBriefs)
        .values({
          orgId,
          workspaceId,
          itemId: item!.id,
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
          itemId: item!.id,
          itemRevision: 1,
          send: 1,
          briefId: brief!.id,
          briefRevision: 1,
          briefDigest: digest,
          idempotencyKey: `${item!.id}:r1:s1`,
          agentId: agent!.id,
          runtimeId: crypto.randomUUID(),
          runtimeTier: "gateway",
          operatorId: crypto.randomUUID(),
          repository: "acme/app",
        })
        .returning({ id: schema.workOrders.id, publicId: schema.workOrders.publicId });
      orderId = order!.id;
      orderPublicId = order!.publicId;
      await tx.insert(schema.workItemFacts).values({
        orgId,
        workspaceId,
        itemId: item!.id,
        orderId,
        kind: "run_linked",
        source: "runtime",
        itemRevision: 1,
        runId: runId("linked"),
        actor: "rtm_runtime",
        occurredAt: new Date("2026-10-01T09:00:01.000Z"),
        dedupeKey: `run_linked:${runId("linked")}`,
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.workDirectOrders).where(eq(schema.workDirectOrders.orgId, orgId));
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    });
    await closeDatabase();
  });

  async function directOrders(name: string) {
    return withSystemDb((tx) =>
      tx
        .select()
        .from(schema.workDirectOrders)
        .where(eq(schema.workDirectOrders.runId, runId(name))),
    );
  }

  it("finds the send a run_linked fact ties the run to", async () => {
    claims.next = [];
    await expect(resolveRunWorkOrder(source("linked"))).resolves.toEqual({ id: orderId, kind: "send" });
    expect(await directOrders("linked")).toEqual([]);
  });

  it("reads no run_linked fact from another workspace", async () => {
    await expect(
      productionRunWorkOrderDeps.readLinkedSend({ orgId, workspaceId: otherWorkspaceId }, runId("linked")),
    ).resolves.toBeNull();
  });

  it("takes a claim that names a send to the run's agent, by public id or id", async () => {
    claims.next = [orderPublicId];
    await expect(resolveRunWorkOrder(source("claimed"))).resolves.toEqual({ id: orderId, kind: "send" });
    claims.next = [orderId];
    await expect(resolveRunWorkOrder(source("claimed"))).resolves.toEqual({ id: orderId, kind: "send" });
    expect(await directOrders("claimed")).toEqual([]);
  });

  it("refuses a claim on another agent's send, or from another workspace", async () => {
    const scope = { orgId, workspaceId };
    await expect(productionRunWorkOrderDeps.verifyClaim(scope, orderPublicId, otherPrincipal)).resolves.toBeNull();
    await expect(
      productionRunWorkOrderDeps.verifyClaim({ orgId, workspaceId: otherWorkspaceId }, orderPublicId, agentPrincipal),
    ).resolves.toBeNull();
    await expect(productionRunWorkOrderDeps.verifyClaim(scope, "wo_forged", agentPrincipal)).resolves.toBeNull();
  });

  it("opens one direct work order for a run started outside Oxagen, however often it is rolled up", async () => {
    claims.next = [orderPublicId];
    const run = source("outside", { agentPrincipalId: otherPrincipal, operatorPrincipalId: agentPrincipal });
    const first = await resolveRunWorkOrder(run);
    const second = await resolveRunWorkOrder(run);
    expect(first.kind).toBe("direct");
    expect(second).toEqual(first);
    const rows = await directOrders("outside");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      orgId,
      workspaceId,
      runId: runId("outside"),
      operatorPrincipalId: agentPrincipal,
      agentPrincipalId: otherPrincipal,
      openedAt: new Date("2026-10-01T09:00:00.000Z"),
      itemId: null,
      attachedAt: null,
      attachedBy: null,
    });
    expect(rows[0]!.publicId).toMatch(/^dwo_/);
  });
});
