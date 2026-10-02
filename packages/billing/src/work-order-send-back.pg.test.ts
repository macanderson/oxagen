// The work orders whose runs keep ending with no outcome, against a real
// Postgres (F34, #5085):
//   - an open send whose 3 runs in a row each closed their pull request
//     unmerged goes back, with each run's spend
//   - an open send with one merged run among its 3 does not
//   - a closed send does not, whatever its runs became
//   - a send whose work item is deleted does not
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job);
// a local run without one is skipped, not red. Every row it writes is removed
// in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findWorkOrderSendBacks } from "./work-order-send-back";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The send-back test needs DATABASE_URL on CI.");

describe.skipIf(!enabled)("findWorkOrderSendBacks against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const orgId = crypto.randomUUID();
  const namespace = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  const runId = (name: string) => `tse_f34${tag}${name}`;
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const agentKey = `acme.core.f34${tag}`;
  let workspaceId = "";
  const sends: Record<"failing" | "merged" | "closed" | "deleted", { id: string; publicId: string; itemId: string }> = {
    failing: { id: "", publicId: "", itemId: "" },
    merged: { id: "", publicId: "", itemId: "" },
    closed: { id: "", publicId: "", itemId: "" },
    deleted: { id: "", publicId: "", itemId: "" },
  };

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Send back ${tag}`,
        slug: `f34-${tag}`,
        namespace: namespace(),
        planType: "free",
        status: "active",
      });
      const [ws] = await tx
        .insert(schema.workspaces)
        .values({ orgId, name: "core", slug: `core-${tag}`, namespace: namespace() })
        .returning({ id: schema.workspaces.id });
      workspaceId = ws!.id;

      for (const name of Object.keys(sends) as (keyof typeof sends)[]) {
        const [item] = await tx
          .insert(schema.workItems)
          .values({
            orgId,
            workspaceId,
            number: `F34-${tag}-${name}`,
            subject: `Fix ${name}`,
            origin: "manual",
            deletedAt: name === "deleted" ? hoursAgo(1) : null,
          })
          .returning({ id: schema.workItems.id });
        const digest = `sha256:${"b".repeat(64)}`;
        const [brief] = await tx
          .insert(schema.workBriefs)
          .values({ orgId, workspaceId, itemId: item!.id, revision: 1, itemRevision: 1, body: {}, digest, author: "triage" })
          .returning({ id: schema.workBriefs.id });
        // Each send goes to its own agent, so none holds another's slot.
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
            agentId: crypto.randomUUID(),
            runtimeId: crypto.randomUUID(),
            runtimeTier: "gateway",
            operatorId: crypto.randomUUID(),
            repository: "acme/app",
            releasedAt: name === "closed" ? hoursAgo(1) : null,
            closedAt: name === "closed" ? hoursAgo(1) : null,
          })
          .returning({ id: schema.workOrders.id, publicId: schema.workOrders.publicId });
        sends[name] = { id: order!.id, publicId: order!.publicId, itemId: item!.id };

        // Three runs, 30, 20, and 10 hours ago. Each opened one pull request.
        // The merged send's middle run merged; every other one closed unmerged.
        const runs = [30, 20, 10].map((h, i) => ({ name: `${name}${i}`, startedAt: hoursAgo(h), number: i + 1 }));
        await tx.insert(schema.runTotals).values(
          runs.map((run, i) => ({
            orgId,
            workspaceId,
            runId: runId(run.name),
            runSource: "tacho",
            agentKey,
            startedAt: run.startedAt,
            sealedAt: new Date(run.startedAt.getTime() + 600_000),
            steps: 4,
            modelCalls: 4,
            toolCalls: 0,
            tokens: {},
            costMicros: BigInt(1_000_000 * (i + 1)),
            costBasis: "gateway_observed",
            breakdown: { models: [], tools: [], steps: null },
            rolledUpAt: now,
            workOrderId: order!.id,
            workOrderKind: "send",
          })),
        );
        await tx.insert(schema.runPrOutcomes).values(
          runs.map((run, i) => {
            const landed = name === "merged" && i === 1;
            return {
              orgId,
              workspaceId,
              runId: runId(run.name),
              runSource: "tacho",
              prKey: `github:acme/app#${run.number}`,
              provider: "github",
              repository: "acme/app",
              number: run.number,
              prState: landed ? "merged" : "closed",
              prStateReadAt: now,
              closedAt: run.startedAt,
              merged: landed,
              mergedAt: landed ? run.startedAt : null,
            };
          }),
        );
      }
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.runPrOutcomes).where(eq(schema.runPrOutcomes.orgId, orgId));
      await tx.delete(schema.runTotals).where(eq(schema.runTotals.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    });
    await closeDatabase();
  });

  it("sends back the open send whose 3 runs in a row ended with no outcome, with the spend attached", async () => {
    const found = await findWorkOrderSendBacks({ orgId, workspaceId }, now);
    expect(found).toEqual([
      {
        orderId: sends.failing.id,
        orderPublicId: sends.failing.publicId,
        itemId: sends.failing.itemId,
        agentKey,
        runs: [2, 1, 0].map((i) => ({
          runId: runId(`failing${i}`),
          startedAt: hoursAgo([30, 20, 10][i]!),
          reason: "closed_unmerged",
          cost: { micros: BigInt(1_000_000 * (i + 1)), currency: "USD", basis: "gateway_observed" },
        })),
      },
    ]);
    expect(found[0]!.orderPublicId).toMatch(/^wo_/);
  });

  it("finds nothing in a workspace whose runs name no send", async () => {
    await expect(findWorkOrderSendBacks({ orgId, workspaceId: crypto.randomUUID() }, now)).resolves.toEqual([]);
  });
});
