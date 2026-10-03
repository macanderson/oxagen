// A merged revert of a Work pull request, against a real Postgres (#5244).
//
// These cases prove the issue's definition of done on the path the GitHub App
// webhook calls, recordWorkPullRequestDelivery:
//   - a merged pull request whose body names the send's merged pull request as
//     `Reverts <owner>/<repo>#<n>` records one `reverted` fact on the send, and
//     the same delivery again records none
//   - the item stays done: the stored state is done, it equals the reduction
//     of the stored facts, and only a person's reopen moves it
//   - one revert that names two sends' pull requests records one fact on each
//   - a revert that has not merged, an edit of a merged pull request's body,
//     one made by hand without the line, one that names a pull request in
//     another repository, and one of a send that never merged each record
//     nothing
//   - get_work_outcomes reads the stored revert, and an item done in the last
//     30 days waits to count
//
// The original pull request's head and merge arrive as webhook deliveries too,
// so each fact is built by the code that builds it in production.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type FactInput, type FactKind, reduceWorkItem, workOrderKey } from "@oxagen/work/records";
import { eq } from "drizzle-orm";
import { readWorkOutcomes } from "../work-read/read";
import { recordWorkPullRequestDelivery, workPullRequestDeliveryOf } from "./results";
import {
  type WorkScope,
  type WorkWrite,
  appendFacts,
  approveBrief,
  openWorkOrder,
  readWorkItem,
  recordSource,
  reopenWorkItem,
  saveBrief,
} from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The work revert test needs DATABASE_URL on CI.");

const REPOSITORY = "aintel/platform";
const SHA1 = "1".repeat(40);
const MERGE = "9".repeat(40);
const REVERT_HEAD = "5".repeat(40);
const REVERT_MERGE = "4".repeat(40);

/**
 * Minutes after 09:00 UTC on 2026-10-02. The day is in the past, so the
 * provider's merge time is always before the acceptance, which takes the
 * database clock, and the item's done time is never in the future.
 */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 2, 9, minute)).toISOString();
}

const DRAFT: BriefDraft = {
  repository: REPOSITORY,
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

/** A `pull_request` webhook body, read by workPullRequestDeliveryOf as the route reads it. */
function webhook(input: {
  action?: string;
  repository?: string;
  number: number;
  head: string;
  body?: string;
  merge?: { commit: string; at: string } | null;
  updatedAt: string;
}) {
  const merge = input.merge ?? null;
  const delivery = workPullRequestDeliveryOf({
    action: input.action ?? (merge === null ? "synchronize" : "closed"),
    repository: { full_name: input.repository ?? REPOSITORY },
    pull_request: {
      number: input.number,
      body: input.body ?? null,
      head: { sha: input.head },
      base: { ref: "main" },
      state: merge === null ? "open" : "closed",
      merged: merge !== null,
      merge_commit_sha: merge?.commit ?? null,
      merged_at: merge?.at ?? null,
      updated_at: input.updatedAt,
    },
  });
  if (delivery === null) throw new Error("The webhook body did not parse.");
  return delivery;
}

describe.skipIf(!enabled)("a revert of a Work pull request against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const AMARA = crypto.randomUUID();
  const MARCUS = crypto.randomUUID();
  const RUNTIME = crypto.randomUUID();
  let counter = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runInTenantScope(scope, () => withTenantDb(fn));
  const read = (itemId: string) => inScope((tx) => readWorkItem(tx, scope, itemId));
  const deliver = (delivery: ReturnType<typeof webhook>) => recordWorkPullRequestDelivery(scope, delivery, new Date());

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const { workItemFacts, workOrders, workBriefs, workItems } = schema;
      await tx.delete(workItemFacts).where(eq(workItemFacts.orgId, scope.orgId));
      await tx.delete(workOrders).where(eq(workOrders.orgId, scope.orgId));
      await tx.delete(workBriefs).where(eq(workBriefs.orgId, scope.orgId));
      await tx.delete(workItems).where(eq(workItems.orgId, scope.orgId));
    });
    await closeDatabase();
  });

  /** The stored state equals the reduction of the stored facts. */
  async function expectConsistent(itemId: string): Promise<void> {
    const record = await read(itemId);
    const [row] = await inScope((tx) =>
      tx.select({ state: schema.workItems.state, version: schema.workItems.version }).from(schema.workItems).where(eq(schema.workItems.id, itemId)),
    );
    expect(row?.state).toBe(reduceWorkItem(record.facts).state);
    expect(row?.version).toBe(record.version);
  }

  /**
   * One work item sent to one agent, whose run linked pull request `pr`. With
   * `finish`, GitHub merged it and a person accepted it, so the item is done.
   */
  async function sentItem(pr: number, finish: boolean): Promise<{ itemId: string; orderId: string }> {
    counter += 1;
    const n = counter;
    const itemId = await inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number: `REV-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:rev${tag}${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    });
    let record: WorkWrite = await inScope((tx) =>
      recordSource(tx, scope, {
        itemId,
        material: { subject: "Fix invites", description: "The link 500s.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: at(0),
        dedupeKey: "delivery-1",
      }),
    );
    record = await inScope((tx) =>
      saveBrief(tx, scope, { itemId, expectedVersion: record.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
    );
    record = await inScope((tx) =>
      approveBrief(tx, scope, {
        itemId,
        expectedVersion: record.version,
        itemRevision: 1,
        briefRevision: 1,
        briefDigest: record.projection.latestBrief!.digest,
        actorUserId: MARCUS,
      }),
    );
    const approved = record.projection.approvedBrief!;
    record = await inScope((tx) =>
      openWorkOrder(tx, scope, {
        itemId,
        expectedVersion: record.version,
        itemRevision: record.projection.revision,
        briefRevision: approved.revision,
        briefDigest: approved.digest,
        idempotencyKey: workOrderKey(record.publicId, approved.revision, record.projection.nextSend),
        agentId: crypto.randomUUID(),
        runtimeId: RUNTIME,
        runtimeTier: "gateway",
        mandateId: null,
        budgetReservationId: null,
        operatorId: MARCUS,
        governanceMode: "team",
        operatesAgent: true,
      }),
    );
    const orderId = record.projection.activeOrder!.orderId;
    const run = `tse_${tag}${n}`;
    const runtime = (kind: FactKind, minute: number, extra: Partial<FactInput<FactKind>> = {}): FactInput<FactKind> =>
      ({ kind, source: "runtime", itemRevision: 1, actor: run, occurredAt: at(minute), dedupeKey: `${kind}:${orderId}`, orderId, data: {}, ...extra }) as FactInput<FactKind>;
    await inScope((tx) =>
      appendFacts(tx, scope, {
        itemId,
        facts: [
          runtime("claimed", 5, { data: { host: "tch_runner" } }),
          runtime("run_linked", 6, { runId: run }),
          runtime("pr_linked", 7, { repository: REPOSITORY, prNumber: pr, runId: run }),
        ],
      }),
    );
    if (!finish) return { itemId, orderId };

    // GitHub merges the pull request, and a person accepts the merged head.
    // The base branch requires no check, so Accept rests on the ticks.
    expect(await deliver(webhook({ number: pr, head: SHA1, merge: { commit: MERGE, at: at(10) }, updatedAt: at(10) }))).toBeGreaterThanOrEqual(1);
    record = await inScope((tx) =>
      appendFacts(tx, scope, {
        itemId,
        facts: [
          { kind: "checks_required", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(11), dedupeKey: `required:${orderId}`, orderId, headSha: SHA1, data: { names: [] } } as FactInput<FactKind>,
        ],
      }),
    );
    record = await inScope((tx) =>
      appendFacts(tx, scope, {
        itemId,
        expectedVersion: record.version,
        actorUserId: MARCUS,
        facts: [
          {
            kind: "accepted",
            source: "person",
            itemRevision: 1,
            actor: MARCUS,
            occurredAt: at(12),
            dedupeKey: "accept",
            orderId,
            headSha: SHA1,
            briefDigest: approved.digest,
            data: { criteria: ["c1", "c2"], required_checks: [] },
          } as FactInput<FactKind>,
        ],
      }),
    );
    expect(record.projection.state).toBe("done");
    return { itemId, orderId };
  }

  /** GitHub's Revert button: a pull request whose body names `pr`, merged. */
  function revertOf(pr: number, number: number, body = `Reverts ${REPOSITORY}#${pr}`, repository = REPOSITORY) {
    return webhook({ repository, number, head: REVERT_HEAD, body, merge: { commit: REVERT_MERGE, at: at(40) }, updatedAt: at(40) });
  }

  it("records one revert on the send, records nothing for the same delivery again, and keeps the item done", async () => {
    const { itemId, orderId } = await sentItem(7101, true);
    const before = await read(itemId);

    expect(await deliver(revertOf(7101, 7102))).toBe(1);
    const after = await read(itemId);
    expect(after.projection.state).toBe("done");
    expect(after.version).toBe(before.version + 1);
    const reverts = after.facts.filter((fact) => fact.kind === "reverted");
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({
      source: "provider",
      orderId,
      repository: REPOSITORY,
      prNumber: 7102,
      occurredAt: at(40),
      data: { merge_commit: REVERT_MERGE, reverts: 7101 },
    });
    const order = after.projection.orders.find((entry) => entry.orderId === orderId);
    expect(order).toMatchObject({ done: true, pullRequest: { repository: REPOSITORY, number: 7101 } });
    expect(order?.revert).toEqual({ repository: REPOSITORY, number: 7102, mergeCommit: REVERT_MERGE, at: at(40) });
    await expectConsistent(itemId);

    // GitHub redelivers the merge, with the body as it stands now, and later
    // sends an edit of the merged revert.
    expect(await deliver(revertOf(7101, 7102))).toBe(0);
    expect(await deliver(revertOf(7101, 7102, `Broke sign-in.\n\nReverts ${REPOSITORY}#7101`))).toBe(0);
    expect(await deliver(webhook({ action: "edited", number: 7102, head: REVERT_HEAD, body: `Reverts ${REPOSITORY}#7101`, merge: { commit: REVERT_MERGE, at: at(40) }, updatedAt: at(45) }))).toBe(0);
    const again = await read(itemId);
    expect(again.facts.filter((fact) => fact.kind === "reverted")).toHaveLength(1);
    expect(again.version).toBe(after.version);
    expect(again.projection.state).toBe("done");
    await expectConsistent(itemId);
  });

  it("leaves the reopen to a person, and keeps the revert in the history", async () => {
    const { itemId } = await sentItem(7201, true);
    expect(await deliver(revertOf(7201, 7202))).toBe(1);
    const done = await read(itemId);
    expect(done.projection.state).toBe("done");
    const reopened = await inScope((tx) =>
      reopenWorkItem(tx, scope, { itemId, expectedVersion: done.version, reason: "The change was reverted.", actorUserId: AMARA }),
    );
    expect(reopened.projection).toMatchObject({ state: "triaged", revision: 2, revisionCause: "reopen" });
    expect(reopened.facts.filter((fact) => fact.kind === "reverted")).toHaveLength(1);
    await expectConsistent(itemId);
  });

  it("records nothing for a revert that has not merged, one without the line, one in another repository, or a send that never merged", async () => {
    const { itemId } = await sentItem(7301, true);
    const before = await read(itemId);
    // The revert is open, not merged.
    expect(await deliver(webhook({ number: 7302, head: REVERT_HEAD, body: `Reverts ${REPOSITORY}#7301`, updatedAt: at(40) }))).toBe(0);
    // A pull request merged long ago, whose body someone edits to name the
    // send's pull request. Only the merge delivery counts.
    expect(
      await deliver(
        webhook({ action: "edited", number: 7306, head: REVERT_HEAD, body: `Reverts ${REPOSITORY}#7301`, merge: { commit: REVERT_MERGE, at: at(30) }, updatedAt: at(50) }),
      ),
    ).toBe(0);
    // A revert made by hand: `git revert` writes the commit, not the line.
    expect(await deliver(revertOf(7301, 7303, `This reverts commit ${MERGE}.`))).toBe(0);
    expect(await deliver(revertOf(7301, 7304, "Reverts #7301"))).toBe(0);
    // A pull request merged in another repository changes nothing here.
    expect(await deliver(revertOf(7301, 7305, `Reverts ${REPOSITORY}#7301`, "aintel/other"))).toBe(0);
    const after = await read(itemId);
    expect(after.facts.filter((fact) => fact.kind === "reverted")).toHaveLength(0);
    expect(after.version).toBe(before.version);

    // The send's pull request never merged, so there is nothing to revert.
    const open = await sentItem(7401, false);
    expect(await deliver(revertOf(7401, 7402))).toBe(0);
    expect((await read(open.itemId)).facts.filter((fact) => fact.kind === "reverted")).toHaveLength(0);
    await expectConsistent(open.itemId);
  });

  it("records one revert on each send whose pull request one revert names", async () => {
    const first = await sentItem(7601, true);
    const second = await sentItem(7602, true);
    expect(await deliver(revertOf(7601, 7603, `Reverts ${REPOSITORY}#7601\nReverts ${REPOSITORY}#7602`))).toBe(2);
    for (const [item, reverts] of [
      [first.itemId, 7601],
      [second.itemId, 7602],
    ] as const) {
      const record = await read(item);
      expect(record.projection.state).toBe("done");
      expect(record.facts.filter((fact) => fact.kind === "reverted").map((fact) => [fact.prNumber, fact.data])).toEqual([
        [7603, { merge_commit: REVERT_MERGE, reverts }],
      ]);
      await expectConsistent(item);
    }
  });

  it("reads the stored revert in get_work_outcomes, where a newly done item waits for its 30 days", async () => {
    const { itemId } = await sentItem(7501, true);
    expect(await deliver(revertOf(7501, 7502))).toBe(1);
    const outcomes = await runInTenantScope(scope, () => readWorkOutcomes(scope, 30, new Date()));
    expect(outcomes.reverts).toEqual({ cohort: 0, reverted: 0, waiting: outcomes.reopens.waiting });
    expect(outcomes.reverts.waiting).toBeGreaterThanOrEqual(1);
    expect(outcomes.accepted_merged).toBeGreaterThanOrEqual(1);
    await expectConsistent(itemId);
  });
});
