// Criterion claims against a real Postgres (ADR-244, ADR-251).
//
// The agent working a send may claim that it met a criterion of the brief.
// These cases prove the claim on the code the handler calls, with the item's
// row lock and the facts' dedupe index in play:
//   - the linked run's claim is recorded once, as the agent's word, and shows
//     on the send's claims for the current head; a retry records nothing
//   - the host that claimed the send files its claim as the linked run
//   - another run, another host, and a host whose send has no run yet are
//     refused
//   - a stale head, an unknown criterion, a moved revision, and an ended send
//     are refused
//   - a claim never accepts anything: the item's state stays as it was
//
// Each case enrolls its own agent, runtime, and hosts, so a case that fails
// leaves no busy agent behind for the next one.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type FactKind, type OrderProjection, isWorkRecordError, workOrderKey } from "@oxagen/work/records";
import { eq, inArray } from "drizzle-orm";
import { closeWork, sendWork } from "./actions";
import type { WorkActor } from "./actor";
import { type CriterionClaimAction, type CriterionClaimant, claimWorkCriterion } from "./claims";
import { type ClaimingHost, claimWorkOrder, endWorkOrderRuns, linkWorkOrderRun } from "./runtime";
import { type WorkItemRecord, type WorkScope, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The criterion claim test needs DATABASE_URL on CI.");

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const REPOSITORY = "aintel/platform";
const PR_NUMBER = 734;
const CLAIM_TEXT = "The invite test covers the expired link.";

/**
 * Minutes after 09:00 UTC on 2026-10-03. The provider's times are fixed, so a
 * later head always sorts after an earlier one.
 */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 3, 9, minute)).toISOString();
}

const DRAFT: BriefDraft = {
  repository: REPOSITORY,
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

/** The refusal's work record code. Fails the case when the call succeeds or throws anything else. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isWorkRecordError(error)) return error.code;
    throw error;
  }
  throw new Error("The call was not refused.");
}

describe.skipIf(!enabled)("criterion claims against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const orgNamespace = `k${tag.slice(0, 5)}`;
  const workspaceNamespace = "core";
  /** The operator: he runs the agents and sends the work. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she writes and approves the briefs. */
  const AMARA = crypto.randomUUID();
  const actor: WorkActor = { userId: MARCUS, role: "Owner" };
  let counter = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runInTenantScope(scope, () => withTenantDb(fn));
  const read = (itemId: string) => inScope((tx) => readWorkItem(tx, scope, itemId));

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@claims.test`, status: "active" },
        { id: AMARA, email: `amara-${tag}@claims.test`, status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `Claims ${tag}`,
        slug: `claims-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values({
        id: scope.workspaceId,
        orgId: scope.orgId,
        name: "Core",
        slug: "core",
        namespace: workspaceNamespace,
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const { orgId } = scope;
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.tachoControlCommands).where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx.delete(schema.tachoSessions).where(eq(schema.tachoSessions.orgId, orgId));
      await tx.delete(schema.tachoHosts).where(eq(schema.tachoHosts.orgId, orgId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.runtimes).where(eq(schema.runtimes.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.id, scope.workspaceId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [MARCUS, AMARA]));
    });
    await closeDatabase();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Rig {
    agentPublicId: string;
    agentKey: string;
    /** The agent's own host. The send goes to it, and it claims the order. */
    hostA: ClaimingHost;
    /** A second machine on the same runtime, enrolled for no agent. */
    hostB: ClaimingHost;
  }

  /** A runtime, an agent Marcus operates on it, the agent's host, and a second host on the same runtime. */
  async function rig(): Promise<Rig> {
    counter += 1;
    const n = counter;
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
    const agentKey = `${orgNamespace}.${workspaceNamespace}.${slug}`;
    return withSystemDb(async (tx) => {
      const [runtime] = await tx
        .insert(schema.runtimes)
        .values({ orgId: scope.orgId, workspaceId: scope.workspaceId, name: `Laptop ${n}`, slug: `laptop-${tag}-${n}`, createdById: MARCUS })
        .returning({ id: schema.runtimes.id });
      const [principal] = await tx
        .insert(schema.principals)
        .values({ orgId: scope.orgId, workspaceId: scope.workspaceId, kind: "agent", displayName: `Bot ${n}`, status: "active", parentUserId: MARCUS })
        .returning({ id: schema.principals.id });
      if (!runtime || !principal) throw new Error("fixture insert returned no row");
      const [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          slug,
          name: `Bot ${n}`,
          agentType: "custom",
          status: "active",
          harness: "claude-code",
          principalId: principal.id,
          runtimeId: runtime.id,
          createdById: MARCUS,
        })
        .returning({ id: schema.agents.id, publicId: schema.agents.publicId });
      if (!agent) throw new Error("fixture insert returned no row");

      const enroll = async (suffix: "a" | "b", key: string, agentId: string | null): Promise<ClaimingHost> => {
        const id = crypto.randomUUID();
        const publicId = `tch_${tag}${n}${suffix}`;
        const apiKeyId = crypto.randomUUID();
        await tx.insert(schema.apiKeys).values({
          id: apiKeyId,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          keyPrefix: `oxk_${tag}${n}${suffix}`,
          keyHash: `hash-${tag}-${n}${suffix}`,
          name: `tacho host ${n}${suffix}`,
          scope: { purpose: "tacho_host_v1", host_enrollment_id: publicId },
          createdById: MARCUS,
        });
        await tx.insert(schema.tachoHosts).values({
          id,
          publicId,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          agentKey: key,
          agentId,
          apiKeyId,
          runtimeId: runtime.id,
          hostname: `laptop-${n}${suffix}`,
          hostnameDigest: "sha256:0",
          platform: "darwin",
          osUser: "marcus",
          osUserDigest: "sha256:0",
          devicePublicKey: `pk-${tag}-${n}${suffix}`,
          deviceKeyFingerprint: `fp-${tag}-${n}${suffix}`,
          enrollmentClaims: {},
          enrollmentSignature: "sig",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          status: "active",
          mode: "enforce",
          lastSeenAt: new Date(),
          bundleFeatures: [BUNDLE_FEATURE_WORK_ORDERS],
        });
        return { id, publicId, runtimeId: runtime.id, agentId };
      };
      const hostA = await enroll("a", agentKey, agent.id);
      const hostB = await enroll("b", `${orgNamespace}.${workspaceNamespace}.spare-${n}`, null);
      return { agentPublicId: agent.publicId, agentKey, hostA, hostB };
    });
  }

  interface Item {
    itemId: string;
    publicId: string;
  }

  /** A work item collected from GitHub, its brief saved and approved by Amara, so it is ready to send. */
  async function readyItem(): Promise<Item> {
    counter += 1;
    const n = counter;
    const itemId = await inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number: `CLAIM-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:${tag}${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    });
    const collected = await inScope((tx) =>
      recordSource(tx, scope, {
        itemId,
        material: { subject: "Fix invites", description: "The link 500s.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: at(0),
        dedupeKey: `delivery-${n}`,
      }),
    );
    const saved = await inScope((tx) =>
      saveBrief(tx, scope, { itemId, expectedVersion: collected.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
    );
    const approved = await inScope((tx) =>
      approveBrief(tx, scope, {
        itemId,
        expectedVersion: saved.version,
        itemRevision: 1,
        briefRevision: 1,
        briefDigest: saved.projection.latestBrief!.digest,
        actorUserId: AMARA,
      }),
    );
    expect(approved.projection.state).toBe("ready");
    return { itemId, publicId: approved.publicId };
  }

  interface Sent extends Item {
    orderId: string;
    orderPublicId: string;
  }

  /** A ready item sent to the rig's agent and claimed by the agent's host. No run is linked yet. */
  async function claimedSend(r: Rig): Promise<Sent> {
    const item = await readyItem();
    const record = await read(item.itemId);
    const approved = record.projection.approvedBrief!;
    const result = await inScope((tx) =>
      sendWork(
        tx,
        scope,
        actor,
        {
          item_id: item.publicId,
          version: record.version,
          item_revision: record.projection.revision,
          brief_revision: approved.revision,
          brief_digest: approved.digest,
          agent_id: r.agentPublicId,
          key: workOrderKey(item.publicId, approved.revision, record.projection.nextSend),
        },
        null,
      ),
    );
    const sent = { ...item, orderId: result.write.orderId, orderPublicId: result.write.orderPublicId };
    await inScope((tx) => claimWorkOrder(tx, scope, r.hostA, sent.orderPublicId, new Date()));
    return sent;
  }

  /** A root session on the agent's host, as ingest opens one. Returns its public id (`tse_…`). */
  async function openRun(r: Rig): Promise<string> {
    counter += 1;
    const n = counter;
    const runId = `tse_${tag}run${n}`;
    const sessionUuid = crypto.randomUUID();
    await withSystemDb((tx) =>
      tx.insert(schema.tachoSessions).values({
        id: crypto.randomUUID(),
        publicId: runId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        sessionUuid,
        harnessSessionId: `sess-${tag}-${n}`,
        hostId: r.hostA.id,
        agentKey: r.agentKey,
        rootSessionUuid: sessionUuid,
        runtime: "claude-code",
        harness: "claude-code",
        startedAt: new Date(),
        lastEventAt: new Date(),
        outcome: "running",
        enforcementTier: "harness",
      }),
    );
    return runId;
  }

  /** The pull request the run opened, and the head commit GitHub reports on it at `minute`. */
  function observeHead(sent: Sent, runId: string, head: string, minute: number) {
    return inScope((tx) =>
      appendFacts(tx, scope, {
        itemId: sent.itemId,
        facts: [
          {
            kind: "pr_linked",
            source: "runtime",
            itemRevision: 1,
            orderId: sent.orderId,
            repository: REPOSITORY,
            prNumber: PR_NUMBER,
            runId,
            actor: runId,
            occurredAt: at(5),
            dedupeKey: `pr_linked:${sent.orderId}:${REPOSITORY}#${PR_NUMBER}`,
            data: {},
          },
          {
            kind: "head_observed",
            source: "provider",
            itemRevision: 1,
            orderId: sent.orderId,
            repository: REPOSITORY,
            prNumber: PR_NUMBER,
            headSha: head,
            actor: "github",
            occurredAt: at(minute),
            dedupeKey: `head_observed:${sent.orderId}:${REPOSITORY}#${PR_NUMBER}:${head}`,
            data: {},
          },
        ],
      }),
    );
  }

  interface Working extends Sent {
    runId: string;
  }

  /** A claimed send whose run linked and opened a pull request with head SHA1. */
  async function working(r: Rig): Promise<Working> {
    const sent = await claimedSend(r);
    const runId = await openRun(r);
    expect(await inScope((tx) => linkWorkOrderRun(tx, scope, { host: r.hostA, runId, workOrder: sent.orderPublicId, at: new Date() }))).toBe("linked");
    await observeHead(sent, runId, SHA1, 10);
    return { ...sent, runId };
  }

  function claimAction(sent: Sent, criterion: string, head: string): CriterionClaimAction {
    return { item_id: sent.publicId, work_order_id: sent.orderPublicId, criterion_id: criterion, head_sha: head, text: CLAIM_TEXT };
  }

  const claimAs = (claimant: CriterionClaimant, action: CriterionClaimAction) =>
    inScope((tx) => claimWorkCriterion(tx, scope, claimant, action, new Date()));

  function orderIn(record: WorkItemRecord, orderId: string): OrderProjection {
    const order = record.projection.orders.find((entry) => entry.orderId === orderId);
    if (order === undefined) throw new Error("The work item has no such send.");
    return order;
  }

  const factsOf = (record: WorkItemRecord, kind: FactKind) => record.facts.filter((fact) => fact.kind === kind);

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------

  it("records the linked run's claim once, as the agent's word on the current head, and accepts nothing", async () => {
    const r = await rig();
    const w = await working(r);
    const before = await read(w.itemId);

    const first = await claimAs({ kind: "run", runId: w.runId }, claimAction(w, "c1", SHA1));
    expect(first).toMatchObject({
      repeat: false,
      item: { id: w.publicId, state: before.projection.state, version: before.version + 1 },
      order: { id: w.orderPublicId, send: 1, delivery: "running" },
      claim: { criterion_id: "c1", head_sha: SHA1, run_id: w.runId },
    });

    const after = await read(w.itemId);
    expect(factsOf(after, "criterion_claimed")).toEqual([
      expect.objectContaining({
        source: "agent",
        orderId: w.orderId,
        criterionId: "c1",
        headSha: SHA1,
        runId: w.runId,
        actor: w.runId,
        data: { text: CLAIM_TEXT },
      }),
    ]);
    expect(orderIn(after, w.orderId).claims).toEqual([{ criterionId: "c1", text: CLAIM_TEXT, headSha: SHA1, current: true }]);

    // A claim is the agent's word. It moves nothing, and nothing is accepted.
    expect(after.projection.state).toBe(before.projection.state);
    expect(orderIn(after, w.orderId).acceptance).toBeNull();
    expect(factsOf(after, "accepted")).toEqual([]);

    // The agent asks again after a lost answer: nothing new is recorded.
    const retry = await claimAs({ kind: "run", runId: w.runId }, { ...claimAction(w, "c1", SHA1), text: "Said again." });
    expect(retry).toMatchObject({ repeat: true, item: { version: after.version } });
    const again = await read(w.itemId);
    expect(again.version).toBe(after.version);
    expect(factsOf(again, "criterion_claimed")).toHaveLength(1);
    expect(orderIn(again, w.orderId).claims[0]?.text).toBe(CLAIM_TEXT);
  });

  it("files the claiming host's claim as the run linked to the send, and refuses another host", async () => {
    const r = await rig();
    const w = await working(r);

    const claimed = await claimAs({ kind: "host", host: r.hostA }, claimAction(w, "c2", SHA1));
    expect(claimed).toMatchObject({ repeat: false, claim: { criterion_id: "c2", head_sha: SHA1, run_id: w.runId } });
    expect(factsOf(await read(w.itemId), "criterion_claimed")).toEqual([
      expect.objectContaining({ source: "agent", criterionId: "c2", actor: w.runId, runId: w.runId }),
    ]);

    // A second machine on the same runtime did not claim the send.
    expect(await refusal(claimAs({ kind: "host", host: r.hostB }, claimAction(w, "c1", SHA1)))).toBe("forbidden");
    expect(factsOf(await read(w.itemId), "criterion_claimed")).toHaveLength(1);
  });

  it("refuses a run that is not the send's linked run, and the host's claim before any run links", async () => {
    const r = await rig();
    const sent = await claimedSend(r);

    // The host claimed the send, and no run has linked to it yet.
    expect(await refusal(claimAs({ kind: "host", host: r.hostA }, claimAction(sent, "c1", SHA1)))).toBe("not_allowed");
    const early = await openRun(r);
    expect(await refusal(claimAs({ kind: "run", runId: early }, claimAction(sent, "c1", SHA1)))).toBe("forbidden");

    const linked = await openRun(r);
    expect(await inScope((tx) => linkWorkOrderRun(tx, scope, { host: r.hostA, runId: linked, workOrder: sent.orderPublicId, at: new Date() }))).toBe("linked");
    await observeHead(sent, linked, SHA1, 10);

    // Another session on the same host names itself, but the send is the linked run's.
    expect(await refusal(claimAs({ kind: "run", runId: early }, claimAction(sent, "c1", SHA1)))).toBe("forbidden");
    expect(factsOf(await read(sent.itemId), "criterion_claimed")).toEqual([]);
    expect(await claimAs({ kind: "run", runId: linked }, claimAction(sent, "c1", SHA1))).toMatchObject({ repeat: false });
  });

  it("refuses a claim before Oxagen saw a head, on a stale head, and on a criterion the brief does not have", async () => {
    const r = await rig();
    const sent = await claimedSend(r);
    const runId = await openRun(r);
    await inScope((tx) => linkWorkOrderRun(tx, scope, { host: r.hostA, runId, workOrder: sent.orderPublicId, at: new Date() }));
    const run: CriterionClaimant = { kind: "run", runId };

    expect(await refusal(claimAs(run, claimAction(sent, "c1", SHA1)))).toBe("stale_head");

    await observeHead(sent, runId, SHA1, 10);
    expect(await refusal(claimAs(run, claimAction(sent, "c1", SHA2)))).toBe("stale_head");
    expect(await refusal(claimAs(run, claimAction(sent, "c9", SHA1)))).toBe("invalid_input");
    expect(await claimAs(run, claimAction(sent, "c1", SHA1))).toMatchObject({ repeat: false });

    // A new head: the old claim stays on the old head, and a new claim on the old head is stale.
    await observeHead(sent, runId, SHA2, 20);
    expect(orderIn(await read(sent.itemId), sent.orderId).claims).toEqual([
      { criterionId: "c1", text: CLAIM_TEXT, headSha: SHA1, current: false },
    ]);
    expect(await refusal(claimAs(run, claimAction(sent, "c2", SHA1)))).toBe("stale_head");
    // The claim already recorded on the old head answers as a repeat.
    expect(await claimAs(run, claimAction(sent, "c1", SHA1))).toMatchObject({ repeat: true });
    expect(await claimAs(run, claimAction(sent, "c1", SHA2))).toMatchObject({ repeat: false });
    expect(orderIn(await read(sent.itemId), sent.orderId).claims).toEqual([
      { criterionId: "c1", text: CLAIM_TEXT, headSha: SHA2, current: true },
    ]);
  });

  it("refuses a claim once the item moved past the send's revision", async () => {
    const r = await rig();
    const w = await working(r);
    await inScope((tx) =>
      recordSource(tx, scope, {
        itemId: w.itemId,
        material: { subject: "Fix invites", description: "The link 500s, and the email is wrong too.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: at(15),
        dedupeKey: `delivery-${w.itemId}-changed`,
      }),
    );
    expect((await read(w.itemId)).projection.revision).toBe(2);
    expect(await refusal(claimAs({ kind: "run", runId: w.runId }, claimAction(w, "c1", SHA1)))).toBe("stale_revision");
  });

  it("refuses a claim on a send that is over", async () => {
    const r = await rig();
    const w = await working(r);
    expect(await inScope((tx) => endWorkOrderRuns(tx, scope, w.runId, "completed", new Date()))).toBe(1);
    const ended = await read(w.itemId);
    await inScope((tx) =>
      closeWork(tx, scope, actor, { item_id: w.publicId, version: ended.version, resolution: "declined", reason: "Not this quarter." }),
    );
    expect(orderIn(await read(w.itemId), w.orderId).closed).toBe(true);
    expect(await refusal(claimAs({ kind: "run", runId: w.runId }, claimAction(w, "c1", SHA1)))).toBe("not_allowed");
    expect(factsOf(await read(w.itemId), "criterion_claimed")).toEqual([]);
  });
});
