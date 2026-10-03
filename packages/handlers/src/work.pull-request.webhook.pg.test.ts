// Check results reach a work order, against a real Postgres (P1-04, ADR-251).
//
// A `check_run`, `check_suite`, or `status` delivery names a commit. These
// cases prove on the database's own rows that the delivery reaches the open
// send whose pull request's current head is that commit, and nothing else:
//   - a send at the commit is found, its checks are read and recorded, and a
//     redelivery records nothing new
//   - a send whose head moved on, a commit no send observed, and another
//     repository find nothing
//   - a withdrawn send finds nothing
//
// Each case sends its own item to its own agent, on its own pull request and
// commits, so one case's send never answers another's delivery. GitHub is a
// fake each case controls.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, workOrderKey } from "@oxagen/work/records";
import { eq, inArray } from "drizzle-orm";
import { cancelWork, sendWork } from "./lib/work-records/actions";
import type { WorkActor } from "./lib/work-records/actor";
import type { EvidenceReader } from "./lib/work-records/evidence";
import { recordSendEvidence, recordWorkPullRequestDelivery, workPullRequestDeliveryOf } from "./lib/work-records/results";
import { type WorkScope, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "./lib/work-records/store";
import {
  type WorkChecksDelivery,
  type WorkChecksWebhookDeps,
  recordWorkOrderChecks,
  workChecksWebhookDeps,
  workOrdersAtHead,
} from "./work.pull-request.webhook";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The work order checks webhook test needs DATABASE_URL on CI.");

const REPOSITORY = "aintel/platform";
const INSTALLATION = "61200044";

/** Minutes after 09:00 UTC on 2026-10-02, so a later head always sorts after an earlier one. */
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

/** A `pull_request` delivery that moves pull request `number`'s head to `head`. */
function headMovedTo(number: number, head: string, updatedAt: string) {
  const delivery = workPullRequestDeliveryOf({
    action: "synchronize",
    repository: { full_name: REPOSITORY },
    pull_request: { number, head: { sha: head }, base: { ref: "main" }, state: "open", merged: false, updated_at: updatedAt },
  });
  if (delivery === null) throw new Error("The webhook body did not parse.");
  return delivery;
}

/** A GitHub that reports `head` as the pull request's head, with the required `test` check failed on it. */
function fakeGitHub(head: string): EvidenceReader {
  return {
    async readPullRequest() {
      return { headSha: head, baseRef: "main", state: "open", merged: false, mergeCommitSha: null, mergedAt: null, updatedAt: at(20) };
    },
    async readRequiredChecks() {
      return { ok: true, names: ["test"], sources: { protection: true, rulesets: false } };
    },
    async readChecks(_scope, _repository, sha) {
      return {
        sha,
        statuses: [],
        checkRuns: [
          { name: "test", status: "completed" as const, conclusion: "failure" as const, detailsUrl: null, startedAt: at(21), completedAt: at(22), appName: null },
        ],
      };
    },
  };
}

describe.skipIf(!enabled)("work order checks webhook against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const orgNamespace = `w${tag.slice(0, 5)}`;
  const workspaceNamespace = "core";
  /** The operator: he runs the agents and sends the work. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she writes and approves the briefs. */
  const AMARA = crypto.randomUUID();
  const actor: WorkActor = { userId: MARCUS, role: "Owner" };
  let counter = 0;
  let commits = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runInTenantScope(scope, () => withTenantDb(fn));
  const read = (itemId: string) => inScope((tx) => readWorkItem(tx, scope, itemId));
  const atHead = (delivery: WorkChecksDelivery) => inScope((tx) => workOrdersAtHead(tx, scope, delivery));

  /** A commit no other case uses: 40 lower case hex digits. */
  function commit(): string {
    commits += 1;
    return `${tag}${commits.toString(16)}`.padEnd(40, "0");
  }

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@checks.test`, status: "active" },
        { id: AMARA, email: `amara-${tag}@checks.test`, status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `Checks ${tag}`,
        slug: `checks-${tag}`,
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

  /** An agent Marcus operates, on its own runtime, with a host that takes work orders. */
  async function agent(n: number): Promise<string> {
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
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
      const [row] = await tx
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
      if (!row) throw new Error("fixture insert returned no row");
      const hostPublicId = `tch_${tag}w${n}`;
      const apiKeyId = crypto.randomUUID();
      await tx.insert(schema.apiKeys).values({
        id: apiKeyId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        keyPrefix: `oxk_${tag}w${n}`,
        keyHash: `hash-${tag}-w${n}`,
        name: `tacho host ${n}`,
        scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
        createdById: MARCUS,
      });
      await tx.insert(schema.tachoHosts).values({
        publicId: hostPublicId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        agentKey: `${orgNamespace}.${workspaceNamespace}.${slug}`,
        agentId: row.id,
        apiKeyId,
        runtimeId: runtime.id,
        hostname: `laptop-${n}`,
        hostnameDigest: "sha256:0",
        platform: "darwin",
        osUser: "marcus",
        osUserDigest: "sha256:0",
        devicePublicKey: `pk-${tag}-w${n}`,
        deviceKeyFingerprint: `fp-${tag}-w${n}`,
        enrollmentClaims: {},
        enrollmentSignature: "sig",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        status: "active",
        mode: "enforce",
        lastSeenAt: new Date(),
        bundleFeatures: [BUNDLE_FEATURE_WORK_ORDERS],
      });
      return row.publicId;
    });
  }

  interface InReview {
    itemId: string;
    publicId: string;
    orderId: string;
    orderPublicId: string;
    prNumber: number;
  }

  /**
   * A ready item sent to a fresh agent, the pull request its run named linked
   * on the send, and GitHub's `pull_request` delivery recording `head` as the
   * pull request's head.
   */
  async function sendInReview(head: string): Promise<InReview> {
    counter += 1;
    const n = counter;
    const prNumber = 600 + n;
    const agentPublicId = await agent(n);
    const itemId = await inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number: `CHK-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:${tag}w${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      if (!row) throw new Error("fixture insert returned no row");
      return row.id;
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
    const brief = approved.projection.approvedBrief!;
    const sent = await inScope((tx) =>
      sendWork(
        tx,
        scope,
        actor,
        {
          item_id: approved.publicId,
          version: approved.version,
          item_revision: approved.projection.revision,
          brief_revision: brief.revision,
          brief_digest: brief.digest,
          agent_id: agentPublicId,
          key: workOrderKey(approved.publicId, brief.revision, approved.projection.nextSend),
        },
        null,
      ),
    );
    const orderId = sent.write.orderId;
    const runId = `tse_${tag}run${n}`;
    await inScope((tx) =>
      appendFacts(tx, scope, {
        itemId,
        facts: [
          {
            kind: "pr_linked",
            source: "runtime",
            itemRevision: 1,
            orderId,
            repository: REPOSITORY,
            prNumber,
            runId,
            actor: runId,
            occurredAt: at(5),
            dedupeKey: `pr_linked:${orderId}:${REPOSITORY}#${prNumber}`,
            data: {},
          },
        ],
      }),
    );
    expect(await recordWorkPullRequestDelivery(scope, headMovedTo(prNumber, head, at(10)), new Date())).toBe(1);
    return { itemId, publicId: approved.publicId, orderId, orderPublicId: sent.write.orderPublicId, prNumber };
  }

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------

  it("finds the open send whose pull request's head is the commit, records its checks, and records a redelivery once", async () => {
    const head = commit();
    const sent = await sendInReview(head);
    expect(await atHead({ repository: REPOSITORY, headSha: head })).toEqual([{ itemId: sent.itemId, orderId: sent.orderId }]);

    // The real lookup in each connected workspace, with GitHub faked.
    const deps: WorkChecksWebhookDeps = {
      ...workChecksWebhookDeps,
      connectedScopes: async () => [scope],
      recordEvidence: (s, order, now) => runInTenantScope(s, () => recordSendEvidence(s, order.itemId, order.orderId, fakeGitHub(head), now)),
    };
    const body = {
      action: "completed",
      installation: { id: Number(INSTALLATION) },
      repository: { full_name: "AIntel/Platform" },
      check_run: { name: "test", head_sha: head, status: "completed", conclusion: "failure" },
    };
    // The required list and the failed check.
    expect(await recordWorkOrderChecks({ body, installationId: INSTALLATION }, deps)).toBe(2);
    const record = await read(sent.itemId);
    const order = record.projection.orders.find((entry) => entry.orderId === sent.orderId);
    expect(order).toMatchObject({ head, requiredChecks: ["test"], checks: [{ name: "test", conclusion: "failure", required: true }] });
    expect(record.facts.filter((fact) => fact.kind === "check_observed")).toEqual([
      expect.objectContaining({ orderId: sent.orderId, headSha: head, source: "provider", data: { name: "test", conclusion: "failure" } }),
    ]);

    // GitHub delivers the same result again: nothing new is recorded.
    expect(await recordWorkOrderChecks({ body, installationId: INSTALLATION }, deps)).toBe(0);
    expect((await read(sent.itemId)).version).toBe(record.version);
  });

  it("finds nothing once the head moves on, for a commit no send observed, or in another repository", async () => {
    const first = commit();
    const second = commit();
    const sent = await sendInReview(first);
    expect(await recordWorkPullRequestDelivery(scope, headMovedTo(sent.prNumber, second, at(30)), new Date())).toBe(1);

    expect(await atHead({ repository: REPOSITORY, headSha: first })).toEqual([]);
    expect(await atHead({ repository: REPOSITORY, headSha: second })).toEqual([{ itemId: sent.itemId, orderId: sent.orderId }]);
    expect(await atHead({ repository: REPOSITORY, headSha: commit() })).toEqual([]);
    expect(await atHead({ repository: "aintel/website", headSha: second })).toEqual([]);
  });

  it("finds nothing for a withdrawn send", async () => {
    const head = commit();
    const sent = await sendInReview(head);
    const before = await read(sent.itemId);
    await inScope((tx) =>
      cancelWork(tx, scope, actor, { item_id: sent.publicId, version: before.version, work_order_id: sent.orderPublicId, reason: "Wrong agent." }),
    );
    expect(await atHead({ repository: REPOSITORY, headSha: head })).toEqual([]);
  });
});
