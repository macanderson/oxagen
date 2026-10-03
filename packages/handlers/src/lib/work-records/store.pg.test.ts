// The work record store against a real Postgres (P1-02, #4897).
//
// Every write goes through one locked read, a version check, and
// admitDecision, so these cases prove the lane's completion evidence on the
// write path itself:
//   - stale revision rejection: a stale version, a brief written against an
//     older revision, a send on a superseded brief, a send key for an old send,
//     and an acceptance on an old head commit are each refused
//   - deterministic state reduction: the same facts appended in two orders, one
//     fact per write, leave two items in the same stored state, and the stored
//     state is always reduceWorkItem of the stored facts
//   - one send per item, one busy agent at a time, and a retried send returns
//     the order it opened
//   - tenant scope: another workspace cannot read the item
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, describe, expect, it } from "vitest";
import {
  WORK_FACT_KINDS,
  WORK_FACT_SOURCES,
  WORK_ITEM_STATES as DB_ITEM_STATES,
  WORK_ORDER_FACT_KINDS,
  WORK_RUNTIME_TIERS,
} from "@oxagen/database/schema";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  FACT_KINDS,
  FACT_SOURCES,
  type FactInput,
  type FactKind,
  ORDER_FACT_KINDS,
  RUNTIME_TIERS,
  WORK_ITEM_STATES,
  type BriefDraft,
  reduceWorkItem,
  workOrderKey,
} from "@oxagen/work/records";
import { eq } from "drizzle-orm";
import {
  type OpenWorkOrderInput,
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
if (process.env.CI && !enabled) throw new Error("The work record store test needs DATABASE_URL on CI.");

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const MERGE = "9".repeat(40);

/** Minutes after 10:00 UTC on 2026-10-01. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
}

const DRAFT: BriefDraft = {
  repository: "aintel/platform",
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

describe("work record constants", () => {
  it("match the database's check constraints", () => {
    expect([...DB_ITEM_STATES]).toEqual([...WORK_ITEM_STATES]);
    expect([...WORK_FACT_KINDS]).toEqual([...FACT_KINDS]);
    expect([...WORK_ORDER_FACT_KINDS]).toEqual([...ORDER_FACT_KINDS]);
    expect([...WORK_FACT_SOURCES]).toEqual([...FACT_SOURCES]);
    expect([...WORK_RUNTIME_TIERS]).toEqual([...RUNTIME_TIERS]);
  });
});

describe.skipIf(!enabled)("the work record store against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const other: WorkScope = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const AMARA = crypto.randomUUID();
  const MARCUS = crypto.randomUUID();
  const RUNTIME = crypto.randomUUID();
  let counter = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>, s: WorkScope = scope): Promise<T> =>
    runInTenantScope(s, () => withTenantDb(fn));

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

  async function newItem(): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number: `P102-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:${tag}${n}`,
          sourceUrl: `https://github.com/aintel/platform/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    });
  }

  async function stored(itemId: string) {
    return inScope(async (tx) => {
      const [row] = await tx
        .select({ state: schema.workItems.state, version: schema.workItems.version, revision: schema.workItems.materialRevision })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, itemId));
      return row!;
    });
  }

  /** The stored state always equals the reduction of the stored facts. */
  async function expectConsistent(itemId: string): Promise<void> {
    const record = await inScope((tx) => readWorkItem(tx, scope, itemId));
    const row = await stored(itemId);
    expect(row.state).toBe(reduceWorkItem(record.facts).state);
    expect(row.revision).toBe(record.projection.revision);
    expect(row.version).toBe(record.version);
  }

  function collect(itemId: string, subject = "Fix invites", key = "delivery-1") {
    return inScope((tx) =>
      recordSource(tx, scope, {
        itemId,
        material: { subject, description: "The link 500s.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: at(0),
        dedupeKey: key,
      }),
    );
  }

  /** Collected, triaged, a brief saved by Amara and approved by Marcus. */
  async function readyItem(): Promise<{ itemId: string; record: WorkWrite }> {
    const itemId = await newItem();
    await collect(itemId);
    let record = await inScope((tx) =>
      appendFacts(tx, scope, {
        itemId,
        facts: [
          {
            kind: "triage_recorded",
            source: "oxagen",
            itemRevision: 1,
            actor: "triage",
            occurredAt: at(1),
            dedupeKey: "triage-1",
            data: { decision: "tri_1", outcome: "triaged", duplicate_of: null },
          },
        ],
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
    return { itemId, record };
  }

  function sendInput(itemId: string, record: WorkWrite, over: Partial<OpenWorkOrderInput> = {}): OpenWorkOrderInput {
    const approved = record.projection.approvedBrief!;
    return {
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
      ...over,
    };
  }

  function provider(kind: FactKind, orderId: string, minute: number, extra: Partial<FactInput<FactKind>> = {}): FactInput<FactKind> {
    return {
      kind,
      source: kind === "claimed" || kind === "run_linked" || kind === "run_ended" ? "runtime" : "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `${kind}:${minute}:${extra.headSha ?? ""}`,
      orderId,
      data: {},
      ...extra,
    } as FactInput<FactKind>;
  }

  /** Every fact a send's result arrives as, up to a merge seen before review. */
  function results(orderId: string): FactInput<FactKind>[] {
    return [
      provider("claimed", orderId, 5, { data: { host: "tch_runner" } }),
      provider("run_linked", orderId, 6, { runId: `tse_${tag}a` }),
      provider("pr_linked", orderId, 7, { repository: "aintel/platform", prNumber: 612 }),
      provider("head_observed", orderId, 8, { repository: "aintel/platform", prNumber: 612, headSha: SHA1 }),
      provider("run_ended", orderId, 9, { runId: `tse_${tag}a`, data: { outcome: "stopped" } }),
      provider("checks_required", orderId, 10, { headSha: SHA1, data: { names: ["test"] } }),
      provider("check_observed", orderId, 11, { headSha: SHA1, data: { name: "test", conclusion: "success" } }),
      provider("merged", orderId, 12, { headSha: SHA1, data: { merge_commit: MERGE } }),
    ];
  }

  function accepted(orderId: string, headSha: string, digest: string): FactInput<FactKind> {
    return {
      kind: "accepted",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: at(0),
      dedupeKey: "accept",
      orderId,
      headSha,
      briefDigest: digest,
      // The caller's list is ignored: the store records the checks the gate evaluated.
      data: { criteria: ["c1", "c2"], required_checks: [] },
    } as FactInput<FactKind>;
  }

  it("records the source once, moves the revision only on a material change, and ignores a repeat", async () => {
    const itemId = await newItem();
    const first = await collect(itemId);
    expect(first).toMatchObject({ repeat: false, version: 1, projection: { revision: 1, state: "new" } });
    expect(first.facts.map((fact) => fact.kind)).toEqual(["collected"]);
    expect(await collect(itemId, "Fix invites", "delivery-2")).toMatchObject({ repeat: true, version: 1 });
    const changed = await collect(itemId, "Fix expired invites", "delivery-3");
    expect(changed).toMatchObject({ repeat: false, version: 2, projection: { revision: 2, revisionCause: "source" } });
    await expectConsistent(itemId);
  });

  it("issues criterion ids, approves a brief, and keeps a repeated approval a repeat", async () => {
    const { itemId, record } = await readyItem();
    expect(record.projection.state).toBe("ready");
    expect(record.briefs[0]?.brief.criteria.map((criterion) => criterion.id)).toEqual(["c1", "c2"]);
    expect(record.projection.approvedBrief).toMatchObject({ revision: 1, actor: MARCUS });
    const again = await inScope((tx) =>
      approveBrief(tx, scope, {
        itemId,
        expectedVersion: record.version - 1,
        itemRevision: 1,
        briefRevision: 1,
        briefDigest: record.projection.approvedBrief!.digest,
        actorUserId: MARCUS,
      }),
    );
    expect(again).toMatchObject({ repeat: true, version: record.version });
    await expectConsistent(itemId);
  });

  describe("stale revision rejection", () => {
    it("refuses a decision on a stale version", async () => {
      const { itemId, record } = await readyItem();
      await expect(inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record, { expectedVersion: record.version - 1 })))).rejects.toMatchObject({
        code: "stale_version",
      });
      await expectConsistent(itemId);
    });

    it("refuses to approve a brief written against an older revision", async () => {
      const itemId = await newItem();
      await collect(itemId);
      const saved = await inScope((tx) =>
        saveBrief(tx, scope, { itemId, expectedVersion: 1, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
      );
      const changed = await collect(itemId, "Fix expired invites", "delivery-2");
      await expect(
        inScope((tx) =>
          approveBrief(tx, scope, {
            itemId,
            expectedVersion: changed.version,
            itemRevision: 2,
            briefRevision: 1,
            briefDigest: saved.projection.latestBrief!.digest,
            actorUserId: MARCUS,
          }),
        ),
      ).rejects.toMatchObject({ code: "stale_revision" });
      await expect(
        inScope((tx) =>
          saveBrief(tx, scope, { itemId, expectedVersion: changed.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
        ),
      ).rejects.toMatchObject({ code: "stale_revision" });
    });

    it("refuses a send on a superseded brief and keeps criterion ids through the edit", async () => {
      const { itemId, record } = await readyItem();
      const edited = await inScope((tx) =>
        saveBrief(tx, scope, {
          itemId,
          expectedVersion: record.version,
          itemRevision: 1,
          draft: { ...DRAFT, criteria: [{ ...DRAFT.criteria[1]!, id: "c2" }, { text: "The email links to the page.", tag: "code", intent: "check", provenance: "person" }] },
          actor: AMARA,
          source: "person",
          actorUserId: AMARA,
        }),
      );
      expect(edited.projection).toMatchObject({ state: "changed", revision: 2, revisionCause: "brief" });
      expect(edited.briefs[1]?.brief.criteria.map((criterion) => criterion.id)).toEqual(["c2", "c3"]);
      const reapproved = await inScope((tx) =>
        approveBrief(tx, scope, {
          itemId,
          expectedVersion: edited.version,
          itemRevision: 2,
          briefRevision: 2,
          briefDigest: edited.projection.latestBrief!.digest,
          actorUserId: MARCUS,
        }),
      );
      const stale = sendInput(itemId, reapproved, {
        briefRevision: 1,
        briefDigest: record.projection.approvedBrief!.digest,
        idempotencyKey: workOrderKey(reapproved.publicId, 1, 1),
      });
      await expect(inScope((tx) => openWorkOrder(tx, scope, stale))).rejects.toMatchObject({ code: "stale_brief" });
      const sent = await inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, reapproved)));
      expect(sent).toMatchObject({ send: 1, projection: { state: "sent" } });
      await expectConsistent(itemId);
    });

    it("refuses a send key that names an old send", async () => {
      const { itemId, record } = await readyItem();
      const first = await inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record)));
      const withdrawn = await inScope((tx) =>
        appendFacts(tx, scope, {
          itemId,
          expectedVersion: first.version,
          actorUserId: MARCUS,
          facts: [{ kind: "send_withdrawn", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "w", orderId: first.orderId, data: { reason: "Wrong agent." } } as FactInput<FactKind>],
        }),
      );
      expect(withdrawn.projection.state).toBe("ready");
      const old = sendInput(itemId, withdrawn, { idempotencyKey: workOrderKey(withdrawn.publicId, 1, 9) });
      await expect(inScope((tx) => openWorkOrder(tx, scope, old))).rejects.toMatchObject({ code: "stale_version" });
    });

    it("refuses an acceptance on an old head commit and admits one on the current head", async () => {
      const { itemId, record } = await readyItem();
      const sent = await inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record)));
      const inReview = await inScope((tx) => appendFacts(tx, scope, { itemId, facts: results(sent.orderId).slice(0, 7) }));
      const moved = await inScope((tx) =>
        appendFacts(tx, scope, {
          itemId,
          facts: [
            provider("head_observed", sent.orderId, 13, { repository: "aintel/platform", prNumber: 612, headSha: SHA2 }),
            provider("checks_required", sent.orderId, 14, { headSha: SHA2, data: { names: ["test"] } }),
            provider("check_observed", sent.orderId, 15, { headSha: SHA2, data: { name: "test", conclusion: "success" } }),
          ],
        }),
      );
      const digest = record.projection.approvedBrief!.digest;
      await expect(
        inScope((tx) => appendFacts(tx, scope, { itemId, expectedVersion: moved.version, actorUserId: MARCUS, facts: [accepted(sent.orderId, SHA1, digest)] })),
      ).rejects.toMatchObject({ code: "stale_head" });
      await expect(
        inScope((tx) => appendFacts(tx, scope, { itemId, expectedVersion: inReview.version, actorUserId: MARCUS, facts: [accepted(sent.orderId, SHA2, digest)] })),
      ).rejects.toMatchObject({ code: "stale_version" });
      const ok = await inScope((tx) =>
        appendFacts(tx, scope, { itemId, expectedVersion: moved.version, actorUserId: MARCUS, facts: [accepted(sent.orderId, SHA2, digest)] }),
      );
      expect(ok.projection.activeOrder?.acceptance).toMatchObject({ headSha: SHA2, requiredChecks: ["test"], criteria: ["c1", "c2"] });
      expect(ok.projection.state).toBe("review");
      const reread = await inScope((tx) => readWorkItem(tx, scope, itemId));
      expect(reread.projection.activeOrder?.acceptance?.requiredChecks).toEqual(["test"]);
      await expectConsistent(itemId);
    });
  });

  describe("deterministic state reduction", () => {
    it("stores the same state for the same facts appended in two orders", async () => {
      const a = await readyItem();
      const b = await readyItem();
      const sentA = await inScope((tx) => openWorkOrder(tx, scope, sendInput(a.itemId, a.record)));
      const sentB = await inScope((tx) => openWorkOrder(tx, scope, sendInput(b.itemId, b.record)));

      for (const fact of results(sentA.orderId)) {
        await inScope((tx) => appendFacts(tx, scope, { itemId: a.itemId, facts: [fact] }));
        await expectConsistent(a.itemId);
      }
      for (const fact of results(sentB.orderId).reverse()) {
        await inScope((tx) => appendFacts(tx, scope, { itemId: b.itemId, facts: [fact] }));
        await expectConsistent(b.itemId);
      }
      // A repeated delivery changes nothing.
      const repeat = await inScope((tx) => appendFacts(tx, scope, { itemId: b.itemId, facts: [results(sentB.orderId)[3]!] }));
      expect(repeat.repeat).toBe(true);

      const readA = await inScope((tx) => readWorkItem(tx, scope, a.itemId));
      const readB = await inScope((tx) => readWorkItem(tx, scope, b.itemId));
      const shape = (record: typeof readA) => {
        const { orderId: _id, ...order } = record.projection.activeOrder!;
        return { state: record.projection.state, revision: record.projection.revision, order: { ...order, key: "", briefId: "", briefDigest: "", agentId: "", requestedAt: "" } };
      };
      expect(shape(readA)).toEqual(shape(readB));
      expect(readA.projection).toMatchObject({ state: "review", activeOrder: { delivery: "run_ended", head: SHA1, merge: { headSha: SHA1 } } });
      expect((await stored(a.itemId)).state).toBe((await stored(b.itemId)).state);

      // Merged before review: the acceptance makes both done, and closes both orders.
      for (const [item, sent, record] of [
        [a.itemId, sentA, a.record],
        [b.itemId, sentB, b.record],
      ] as const) {
        const current = await inScope((tx) => readWorkItem(tx, scope, item));
        const done = await inScope((tx) =>
          appendFacts(tx, scope, {
            itemId: item,
            expectedVersion: current.version,
            actorUserId: MARCUS,
            facts: [accepted(sent.orderId, SHA1, record.projection.approvedBrief!.digest)],
          }),
        );
        expect(done.projection.state).toBe("done");
        await expectConsistent(item);
      }
      const [order] = await inScope((tx) =>
        tx.select({ releasedAt: schema.workOrders.releasedAt, closedAt: schema.workOrders.closedAt }).from(schema.workOrders).where(eq(schema.workOrders.id, sentA.orderId)),
      );
      expect(order?.releasedAt).toBeInstanceOf(Date);
      expect(order?.closedAt).toBeInstanceOf(Date);
    });
  });

  describe("sends", () => {
    it("returns the order a retried send opened, and refuses a key reused for another agent", async () => {
      const { itemId, record } = await readyItem();
      const input = sendInput(itemId, record);
      const first = await inScope((tx) => openWorkOrder(tx, scope, input));
      const retry = await inScope((tx) => openWorkOrder(tx, scope, input));
      expect(retry).toMatchObject({ repeat: true, orderId: first.orderId, send: 1 });
      await expect(inScope((tx) => openWorkOrder(tx, scope, { ...input, agentId: crypto.randomUUID() }))).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses a second send to an agent whose run has not ended, and frees it when the run ends", async () => {
      const agentId = crypto.randomUUID();
      const one = await readyItem();
      const two = await readyItem();
      const sent = await inScope((tx) => openWorkOrder(tx, scope, sendInput(one.itemId, one.record, { agentId })));
      await expect(inScope((tx) => openWorkOrder(tx, scope, sendInput(two.itemId, two.record, { agentId })))).rejects.toMatchObject({
        code: "conflict",
      });
      await inScope((tx) => appendFacts(tx, scope, { itemId: one.itemId, facts: [provider("run_ended", sent.orderId, 9, { runId: `tse_${tag}b`, data: { outcome: null } })] }));
      const second = await inScope((tx) => openWorkOrder(tx, scope, sendInput(two.itemId, two.record, { agentId })));
      expect(second.projection.state).toBe("sent");
    });

    it("refuses the approver as the sender in a regulated workspace, and a sender who does not operate the agent", async () => {
      const { itemId, record } = await readyItem();
      await expect(inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record, { governanceMode: "regulated" })))).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record, { operatesAgent: false })))).rejects.toMatchObject({
        code: "forbidden",
      });
      const byAmara = await inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record, { governanceMode: "regulated", operatorId: AMARA })));
      expect(byAmara.projection.state).toBe("sent");
    });

    it("refuses a runtime's claim on a withdrawn send, so the runtime does not start it", async () => {
      const { itemId, record } = await readyItem();
      const sent = await inScope((tx) => openWorkOrder(tx, scope, sendInput(itemId, record)));
      await inScope((tx) =>
        appendFacts(tx, scope, {
          itemId,
          expectedVersion: sent.version,
          actorUserId: MARCUS,
          facts: [{ kind: "send_withdrawn", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "w", orderId: sent.orderId, data: { reason: "Wrong agent." } } as FactInput<FactKind>],
        }),
      );
      await expect(
        inScope((tx) => appendFacts(tx, scope, { itemId, facts: [provider("claimed", sent.orderId, 6, { data: { host: "tch_runner" } })] })),
      ).rejects.toMatchObject({ code: "not_allowed" });
    });
  });

  describe("appendFacts and reopen", () => {
    it("refuses kinds the store writes itself, a decision with no version, and a decision from another source", async () => {
      const { itemId, record } = await readyItem();
      const approval = { kind: "brief_approved", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "x", data: { revision: 1 } };
      await expect(inScope((tx) => appendFacts(tx, scope, { itemId, facts: [approval as FactInput<FactKind>] }))).rejects.toMatchObject({
        code: "invalid_input",
      });
      const close = { kind: "closed", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "c", data: { resolution: "declined", reason: "Not now." } };
      await expect(inScope((tx) => appendFacts(tx, scope, { itemId, facts: [close as FactInput<FactKind>] }))).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        inScope((tx) => appendFacts(tx, scope, { itemId, expectedVersion: record.version, facts: [{ ...close, source: "oxagen" } as FactInput<FactKind>] })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        inScope((tx) => appendFacts(tx, scope, { itemId, facts: [provider("claimed", crypto.randomUUID(), 5, { data: { host: null } })] })),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("closes, reopens on a new revision, and needs a newly approved brief", async () => {
      const { itemId, record } = await readyItem();
      const closed = await inScope((tx) =>
        appendFacts(tx, scope, {
          itemId,
          expectedVersion: record.version,
          actorUserId: MARCUS,
          facts: [{ kind: "closed", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "c", data: { resolution: "declined", reason: "Not now." } } as FactInput<FactKind>],
        }),
      );
      expect(closed.projection.state).toBe("closed");
      const reopened = await inScope((tx) => reopenWorkItem(tx, scope, { itemId, expectedVersion: closed.version, reason: "It came back.", actorUserId: AMARA }));
      expect(reopened.projection).toMatchObject({ state: "triaged", revision: 2, revisionCause: "reopen", approvedBrief: null });
      // A send on the brief approved before the reopen names a revision that is gone.
      const before = sendInput(itemId, record, { expectedVersion: reopened.version });
      await expect(inScope((tx) => openWorkOrder(tx, scope, before))).rejects.toMatchObject({ code: "stale_revision" });
      // On the current revision, nothing is approved yet.
      await expect(inScope((tx) => openWorkOrder(tx, scope, { ...before, itemRevision: 2 }))).rejects.toMatchObject({ code: "not_allowed" });
      await expectConsistent(itemId);
    });

    it("refuses a retried save or reopen on the old version, and writes no second brief or reopen", async () => {
      const itemId = await newItem();
      const collected = await collect(itemId);
      const save = () =>
        inScope((tx) =>
          saveBrief(tx, scope, { itemId, expectedVersion: collected.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
        );
      const saved = await save();
      await expect(save()).rejects.toMatchObject({ code: "stale_version" });
      const briefRows = await inScope((tx) => tx.select({ id: schema.workBriefs.id }).from(schema.workBriefs).where(eq(schema.workBriefs.itemId, itemId)));
      expect(briefRows).toHaveLength(1);

      const closed = await inScope((tx) =>
        appendFacts(tx, scope, {
          itemId,
          expectedVersion: saved.version,
          actorUserId: MARCUS,
          facts: [{ kind: "closed", source: "person", itemRevision: 1, actor: MARCUS, occurredAt: at(0), dedupeKey: "c", data: { resolution: "declined", reason: "Not now." } } as FactInput<FactKind>],
        }),
      );
      const reopen = () => inScope((tx) => reopenWorkItem(tx, scope, { itemId, expectedVersion: closed.version, reason: "It came back.", actorUserId: AMARA }));
      expect(await reopen()).toMatchObject({ repeat: false, projection: { revision: 2 } });
      await expect(reopen()).rejects.toMatchObject({ code: "stale_version" });

      const record = await inScope((tx) => readWorkItem(tx, scope, itemId));
      expect(record.facts.filter((fact) => fact.kind === "brief_saved")).toHaveLength(1);
      expect(record.facts.filter((fact) => fact.kind === "reopened")).toHaveLength(1);
      expect(record.projection.revision).toBe(2);
      await expectConsistent(itemId);
    });
  });

  it("finds no item from another workspace", async () => {
    const { itemId } = await readyItem();
    await expect(inScope((tx) => readWorkItem(tx, other, itemId), other)).rejects.toMatchObject({ code: "not_found" });
  });
});
