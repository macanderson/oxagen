// Work order dispatch against a real Postgres (P1-04, #5100, ADR-250).
//
// These cases prove the lane's completion evidence on the code the handlers
// call, with the database's own indexes and row locks in play:
//   - retry safety: a retried send returns the order and the command the first
//     try wrote, so the runtime is offered one command for one send
//   - one active claimant: the agent's host claims a send, a repeat of its
//     claim gets the same claim and prompt back, and a second machine on the
//     same runtime is refused
//   - stale-head invalidation: a new head on the pull request voids the
//     acceptance, and an acceptance that names the old head is refused
//   - fail-closed review checks: a required list Oxagen could not read, a
//     failing, missing, skipped, or cancelled required check, and an unticked
//     criterion each refuse Accept, and the evidence read at the press stays
//   - acceptance separated from merge: accepting merges nothing, and the item
//     is done once it is accepted and merged, in either order
//   - the drain gate: a host that does not advertise work orders is never
//     handed one, and gets it on the first poll after it does
//
// Each case enrolls its own agent, runtime, and hosts, so a case that fails
// leaves no busy agent behind for the next one. GitHub is a fake each case
// controls.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import type { GitHubCheckRun, RequiredChecksRead } from "@oxagen/github";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type FactKind, type OrderProjection, isWorkRecordError, workOrderKey } from "@oxagen/work/records";
import { and, eq, inArray } from "drizzle-orm";
import { drainCommands, type TachoHostRow } from "../tacho-host";
import { type AcceptAction, type ReviewDeps, acceptWork, refreshWorkChecks } from "./accept";
import { type SendAction, cancelWork, closeWork, returnWork, sendOutput, sendWork, stopWork } from "./actions";
import type { WorkActor } from "./actor";
import { stopCommandKey } from "./delivery";
import type { EvidenceReader } from "./evidence";
import { recordRunPullRequest, recordWorkPullRequestDelivery, workPullRequestDeliveryOf } from "./results";
import {
  type AckedCommand,
  type ClaimingHost,
  claimWorkOrder,
  endWorkOrderRuns,
  linkWorkOrderRun,
  recordWorkOrderAcks,
  rejectWorkOrder,
} from "./runtime";
import { type WorkItemRecord, type WorkScope, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The work order dispatch test needs DATABASE_URL on CI.");

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const MERGE = "9".repeat(40);
const REPOSITORY = "aintel/platform";
const PR_NUMBER = 612;
const PR_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`;
const CRITERIA = ["c1", "c2"];
const RETURN_REASON = "The test covers the wrong page.";

/**
 * Minutes after 09:00 UTC on 2026-10-02. The provider's times are fixed, so a
 * later head always sorts after an earlier one: reduceWorkItem orders facts by
 * time, and the latest head_observed is the head.
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

/** A read of the base branch's required checks that succeeded. */
function required(names: string[]): RequiredChecksRead {
  return { ok: true, names: [...names].sort(), sources: { protection: true, rulesets: false } };
}

type Conclusion = NonNullable<GitHubCheckRun["conclusion"]>;

/** What the fake GitHub reports about the pull request, each at a fixed time. */
interface GitHubState {
  head: string;
  updatedAt: string;
  merge: { commit: string; at: string } | null;
  required: RequiredChecksRead;
  checks: Record<string, Conclusion>;
  checkedAt: string;
}

/** A `pull_request` webhook body for the pull request, read by workPullRequestDeliveryOf. */
function webhook(head: string, updatedAt: string, merge: { commit: string; at: string } | null = null) {
  const delivery = workPullRequestDeliveryOf({
    action: merge === null ? "synchronize" : "closed",
    repository: { full_name: REPOSITORY },
    pull_request: {
      number: PR_NUMBER,
      head: { sha: head },
      base: { ref: "main" },
      state: merge === null ? "open" : "closed",
      merged: merge !== null,
      merge_commit_sha: merge?.commit ?? null,
      merged_at: merge?.at ?? null,
      updated_at: updatedAt,
    },
  });
  if (delivery === null) throw new Error("The webhook body did not parse.");
  return delivery;
}

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

describe.skipIf(!enabled)("work order dispatch against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const orgNamespace = `p${tag.slice(0, 5)}`;
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
        { id: MARCUS, email: `marcus-${tag}@dispatch.test`, status: "active" },
        { id: AMARA, email: `amara-${tag}@dispatch.test`, status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `P104 ${tag}`,
        slug: `p104-${tag}`,
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

  /**
   * A runtime, an agent Marcus operates on it, the agent's host, and a second
   * host on the same runtime. Both hosts advertise `features`.
   */
  async function rig(features: string[] = [BUNDLE_FEATURE_WORK_ORDERS]): Promise<Rig> {
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
          bundleFeatures: features,
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
    number: string;
  }

  /** A work item collected from GitHub, its brief saved and approved by Amara, so it is ready to send. */
  async function readyItem(): Promise<Item> {
    counter += 1;
    const n = counter;
    const number = `P104-${tag}-${n}`;
    const itemId = await inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number,
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
    return { itemId, publicId: approved.publicId, number };
  }

  /** The send a person's page submits for the item as it reads now. */
  async function sendAction(item: Item, r: Rig): Promise<SendAction> {
    const record = await read(item.itemId);
    const approved = record.projection.approvedBrief!;
    return {
      item_id: item.publicId,
      version: record.version,
      item_revision: record.projection.revision,
      brief_revision: approved.revision,
      brief_digest: approved.digest,
      agent_id: r.agentPublicId,
      key: workOrderKey(item.publicId, approved.revision, record.projection.nextSend),
    };
  }

  interface Sent {
    orderId: string;
    orderPublicId: string;
    key: string;
    commandId: string;
  }

  async function send(item: Item, r: Rig): Promise<Sent> {
    const input = await sendAction(item, r);
    const result = await inScope((tx) => sendWork(tx, scope, actor, input, null));
    return { orderId: result.write.orderId, orderPublicId: result.write.orderPublicId, key: input.key, commandId: result.commandId };
  }

  interface Run {
    /** The session row's id. */
    id: string;
    /** The session's public id (`tse_…`). */
    runId: string;
    sessionUuid: string;
  }

  /** A root session on the agent's host, as ingest opens one. */
  async function openRun(r: Rig): Promise<Run> {
    counter += 1;
    const n = counter;
    const run: Run = { id: crypto.randomUUID(), runId: `tse_${tag}run${n}`, sessionUuid: crypto.randomUUID() };
    await withSystemDb((tx) =>
      tx.insert(schema.tachoSessions).values({
        id: run.id,
        publicId: run.runId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        sessionUuid: run.sessionUuid,
        harnessSessionId: `sess-${tag}-${n}`,
        hostId: r.hostA.id,
        agentKey: r.agentKey,
        rootSessionUuid: run.sessionUuid,
        runtime: "claude-code",
        harness: "claude-code",
        startedAt: new Date(),
        lastEventAt: new Date(),
        outcome: "running",
        enforcementTier: "harness",
      }),
    );
    return run;
  }

  const claim = (host: ClaimingHost, orderPublicId: string) => inScope((tx) => claimWorkOrder(tx, scope, host, orderPublicId, new Date()));
  const link = (host: ClaimingHost, orderPublicId: string, runId: string) =>
    inScope((tx) => linkWorkOrderRun(tx, scope, { host, runId, workOrder: orderPublicId, at: new Date() }));
  const endRun = (runId: string) => inScope((tx) => endWorkOrderRuns(tx, scope, runId, "completed", new Date()));
  const acks = (host: ClaimingHost, acked: AckedCommand[]) => inScope((tx) => recordWorkOrderAcks(tx, scope, host, acked, new Date()));

  /** The pull request the run named, recorded on the send the way results.ts records it. */
  function linkPullRequest(item: Item, sent: Sent, run: Run) {
    return inScope((tx) =>
      appendFacts(tx, scope, {
        itemId: item.itemId,
        facts: [
          {
            kind: "pr_linked",
            source: "runtime",
            itemRevision: 1,
            orderId: sent.orderId,
            repository: REPOSITORY,
            prNumber: PR_NUMBER,
            runId: run.runId,
            actor: run.runId,
            occurredAt: at(5),
            dedupeKey: `pr_linked:${sent.orderId}:${REPOSITORY}#${PR_NUMBER}`,
            data: {},
          },
        ],
      }),
    );
  }

  interface InReview extends Item, Sent {
    run: Run;
  }

  /** A ready item sent to the rig's agent, claimed, run, and ended, with its pull request linked unless asked not to. */
  async function inReview(r: Rig, options: { pullRequest: boolean } = { pullRequest: true }): Promise<InReview> {
    const item = await readyItem();
    const sent = await send(item, r);
    await claim(r.hostA, sent.orderPublicId);
    const run = await openRun(r);
    expect(await link(r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    expect(await endRun(run.runId)).toBe(1);
    if (options.pullRequest) await linkPullRequest(item, sent, run);
    return { ...item, ...sent, run };
  }

  /** A GitHub the case controls, and the Accept seams that read it. */
  function fakeGitHub(over: Partial<GitHubState> = {}) {
    const github: GitHubState = {
      head: SHA1,
      updatedAt: at(10),
      merge: null,
      required: required(["test"]),
      checks: { test: "success" },
      checkedAt: at(11),
      ...over,
    };
    const reader: EvidenceReader = {
      async readPullRequest() {
        return {
          headSha: github.head,
          baseRef: "main",
          state: github.merge === null ? "open" : "closed",
          merged: github.merge !== null,
          mergeCommitSha: github.merge?.commit ?? null,
          mergedAt: github.merge?.at ?? null,
          updatedAt: github.updatedAt,
        };
      },
      async readRequiredChecks() {
        return github.required;
      },
      async readChecks(_scope, _repository, sha) {
        return {
          sha,
          statuses: [],
          checkRuns: Object.entries(github.checks).map(([name, conclusion]) => ({
            name,
            status: "completed" as const,
            conclusion,
            detailsUrl: null,
            startedAt: github.checkedAt,
            completedAt: github.checkedAt,
            appName: null,
          })),
        };
      },
    };
    const deps: ReviewDeps = { db: inScope, reader, now: () => new Date() };
    return { github, deps };
  }

  /** The Accept a person's page submits on `head`, for the item as `record` read it. */
  function acceptance(record: WorkItemRecord, orderPublicId: string, head: string, criteria: string[] = CRITERIA): AcceptAction {
    return {
      item_id: record.publicId,
      version: record.version,
      work_order_id: orderPublicId,
      head_sha: head,
      brief_digest: record.projection.approvedBrief!.digest,
      criteria,
    };
  }

  function orderIn(record: WorkItemRecord, orderId: string): OrderProjection {
    const order = record.projection.orders.find((entry) => entry.orderId === orderId);
    if (order === undefined) throw new Error("The work item has no such send.");
    return order;
  }

  const factsOf = (record: WorkItemRecord, kind: FactKind) => record.facts.filter((fact) => fact.kind === kind);

  const commandsByKey = (key: string) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(and(eq(schema.tachoControlCommands.orgId, scope.orgId), eq(schema.tachoControlCommands.idempotencyKey, key))),
    );

  // -------------------------------------------------------------------------
  // Send and claim
  // -------------------------------------------------------------------------

  it("returns the same order and command for a retried send, and queues one work_order command for the agent's host", async () => {
    const r = await rig();
    const item = await readyItem();
    const input = await sendAction(item, r);
    const first = await inScope((tx) => sendWork(tx, scope, actor, input, null));
    const retry = await inScope((tx) => sendWork(tx, scope, actor, input, null));
    expect(first.write.repeat).toBe(false);
    expect(retry.write.repeat).toBe(true);
    expect(retry.write.orderId).toBe(first.write.orderId);
    expect(retry.commandId).toBe(first.commandId);
    expect(sendOutput(first)).toMatchObject({
      item: { state: "sent" },
      order: { send: 1, key: input.key, delivery: "waiting_for_claim" },
      command_id: first.commandId,
      target: { agent_id: r.agentPublicId, host_id: r.hostA.publicId, runtime_tier: "harness" },
    });

    const commands = await commandsByKey(input.key);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      publicId: first.commandId,
      command: "work_order",
      hostId: r.hostA.id,
      targetKind: "host",
      targetId: r.hostA.publicId,
      outcome: "queued",
      payload: { work_order: first.write.orderPublicId, key: input.key, item: item.publicId },
    });
    const orders = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workOrders.id })
        .from(schema.workOrders)
        .where(and(eq(schema.workOrders.orgId, scope.orgId), eq(schema.workOrders.idempotencyKey, input.key))),
    );
    expect(orders).toHaveLength(1);

    // A retry that lands after the host claimed still finds the send it opened.
    await claim(r.hostA, first.write.orderPublicId);
    const late = await inScope((tx) => sendWork(tx, scope, actor, input, null));
    expect(late).toMatchObject({ commandId: first.commandId, write: { repeat: true, orderId: first.write.orderId } });
    expect(await commandsByKey(input.key)).toHaveLength(1);
  });

  it("lets the agent's host claim a send once, answers its repeat with the same prompt, and refuses any other host", async () => {
    const r = await rig();
    const elsewhere = await rig();
    const item = await readyItem();
    const sent = await send(item, r);

    const first = await claim(r.hostA, sent.orderPublicId);
    expect(first).toMatchObject({
      repeat: false,
      order: { delivery: "claimed" },
      orderPublicId: sent.orderPublicId,
      itemPublicId: item.publicId,
      itemNumber: item.number,
      repository: REPOSITORY,
      agentPublicId: r.agentPublicId,
      harness: "claude-code",
    });
    expect(first.prompt).toContain(`Work order ${sent.orderPublicId} for ${item.number}, brief revision 1.`);
    expect(first.prompt).toContain("- c1 (check): An expired invite shows the expiry message.");
    expect(first.prompt).toContain("- c2 (review): The copy follows the house voice.");
    expect(first.prompt).toContain("```\nFix invites\n\nThe link 500s.\n```");

    // The host asks again after a lost answer: the same claim and prompt, and nothing new recorded.
    const again = await claim(r.hostA, sent.orderPublicId);
    expect(again.repeat).toBe(true);
    expect(again.prompt).toBe(first.prompt);

    // A second machine on the same runtime is refused: the work order was
    // addressed to the agent's own host.
    expect(await refusal(claim(r.hostB, sent.orderPublicId))).toBe("forbidden");
    // A host on another runtime is not the target at all.
    expect(await refusal(claim(elsewhere.hostA, sent.orderPublicId))).toBe("forbidden");

    const record = await read(item.itemId);
    expect(factsOf(record, "claimed")).toEqual([
      expect.objectContaining({ orderId: sent.orderId, actor: r.hostA.publicId, data: { host: r.hostA.publicId } }),
    ]);
  });

  it("refuses a second item's send to an agent that already has a send out", async () => {
    const r = await rig();
    const one = await readyItem();
    const two = await readyItem();
    await send(one, r);
    const input = await sendAction(two, r);
    expect(await refusal(inScope((tx) => sendWork(tx, scope, actor, input, null)))).toBe("conflict");
    expect((await read(two.itemId)).projection).toMatchObject({ state: "ready", orders: [] });
    expect(await commandsByKey(input.key)).toEqual([]);
  });

  it("withdraws an unclaimed send, cancels its command, and refuses a later claim", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    const before = await read(item.itemId);
    const withdrawn = await inScope((tx) =>
      cancelWork(tx, scope, actor, { item_id: item.publicId, version: before.version, work_order_id: sent.orderPublicId, reason: "Wrong agent." }),
    );
    expect(withdrawn).toMatchObject({ repeat: false, item: { state: "ready" }, order: { delivery: "withdrawn" } });
    expect(await commandsByKey(sent.key)).toEqual([expect.objectContaining({ outcome: "cancelled", outcomeDetail: "withdrawn" })]);

    expect(await refusal(claim(r.hostA, sent.orderPublicId))).toBe("not_allowed");
    expect(factsOf(await read(item.itemId), "claimed")).toEqual([]);
  });

  it("refuses to withdraw a send its host already claimed, and leaves the command queued", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    await claim(r.hostA, sent.orderPublicId);
    const claimed = await read(item.itemId);
    expect(
      await refusal(
        inScope((tx) =>
          cancelWork(tx, scope, actor, { item_id: item.publicId, version: claimed.version, work_order_id: sent.orderPublicId, reason: "Wrong agent." }),
        ),
      ),
    ).toBe("not_allowed");
    expect(await commandsByKey(sent.key)).toEqual([expect.objectContaining({ outcome: "queued" })]);
    expect(orderIn(await read(item.itemId), sent.orderId).delivery).toBe("claimed");
  });

  it("withdraws a claimed send after a stop no run confirmed, and stops a run that links later", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    await claim(r.hostA, sent.orderPublicId);
    // The host claimed it and then went away: no run links.
    const claimed = await read(item.itemId);
    await inScope((tx) =>
      stopWork(tx, scope, actor, { item_id: item.publicId, version: claimed.version, work_order_id: sent.orderPublicId, reason: "The laptop is gone." }),
    );
    expect(orderIn(await read(item.itemId), sent.orderId).delivery).toBe("stopping");
    const stopping = await read(item.itemId);
    const withdrawn = await inScope((tx) =>
      cancelWork(tx, scope, actor, { item_id: item.publicId, version: stopping.version, work_order_id: sent.orderPublicId, reason: "The runtime never confirmed." }),
    );
    expect(withdrawn).toMatchObject({ item: { state: "ready" }, order: { delivery: "withdrawn" } });

    // The host comes back and its run reports: the run is stopped, and the send stays ended.
    const run = await openRun(r);
    expect(await link(r.hostA, sent.orderPublicId, run.runId)).toBe("ended");
    expect(await commandsByKey(stopCommandKey(sent.key, run.runId))).toEqual([
      expect.objectContaining({ command: "cancel", outcome: "queued", targetId: run.runId }),
    ]);
    expect(orderIn(await read(item.itemId), sent.orderId)).toMatchObject({ delivery: "withdrawn", runIds: [] });
  });

  it("closes an item only after its send has ended", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    const close = (version: number) =>
      inScope((tx) => closeWork(tx, scope, actor, { item_id: item.publicId, version, resolution: "declined", reason: "Not this quarter." }));
    const out = await read(item.itemId);
    expect(await refusal(close(out.version))).toBe("not_allowed");
    await inScope((tx) =>
      cancelWork(tx, scope, actor, { item_id: item.publicId, version: out.version, work_order_id: sent.orderPublicId, reason: "Not this quarter." }),
    );
    const withdrawn = await read(item.itemId);
    expect(await close(withdrawn.version)).toMatchObject({ repeat: false, item: { state: "closed" } });
  });

  it("records a host's rejection once, and refuses a rejection from another host or after a run links", async () => {
    const r = await rig();
    const reject = (host: ClaimingHost, orderPublicId: string) =>
      inScope((tx) => rejectWorkOrder(tx, scope, host, orderPublicId, "This machine has no checkout of aintel/platform.", new Date()));

    const first = await readyItem();
    const one = await send(first, r);
    expect(await reject(r.hostA, one.orderPublicId)).toEqual({ repeat: false });
    expect(await reject(r.hostA, one.orderPublicId)).toEqual({ repeat: true });
    expect(await refusal(claim(r.hostA, one.orderPublicId))).toBe("not_allowed");
    expect((await read(first.itemId)).projection).toMatchObject({
      state: "ready",
      orders: [expect.objectContaining({ delivery: "rejected", released: true })],
    });

    // The rejection freed the agent, so the next item goes to it.
    const second = await readyItem();
    const two = await send(second, r);
    await claim(r.hostA, two.orderPublicId);
    expect(await refusal(reject(r.hostB, two.orderPublicId))).toBe("forbidden");
    const run = await openRun(r);
    await link(r.hostA, two.orderPublicId, run.runId);
    expect(await refusal(reject(r.hostA, two.orderPublicId))).toBe("not_allowed");
  });

  // -------------------------------------------------------------------------
  // Runs, stops, and acknowledgements
  // -------------------------------------------------------------------------

  it("links the claiming host's first run, leaves other runs and hosts unlinked, and records the run's end once", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    const run = await openRun(r);
    // A run that names the order before any claim links nothing.
    expect(await link(r.hostA, sent.orderPublicId, run.runId)).toBe("not_claimed");
    await claim(r.hostA, sent.orderPublicId);
    expect(await refusal(link(r.hostB, sent.orderPublicId, run.runId))).toBe("forbidden");
    expect(await link(r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    // Once a run is linked, a repeat claim is refused: a run already started.
    expect(await refusal(claim(r.hostA, sent.orderPublicId))).toBe("not_allowed");
    expect((await read(item.itemId)).projection).toMatchObject({
      state: "running",
      activeOrder: { delivery: "running", runIds: [run.runId] },
    });
    expect(await link(r.hostA, sent.orderPublicId, run.runId)).toBe("repeat");
    // A second run that names the same send is stopped, so the work runs once.
    const late = await openRun(r);
    expect(await link(r.hostA, sent.orderPublicId, late.runId)).toBe("already_linked");
    expect(await commandsByKey(stopCommandKey(sent.key, late.runId))).toEqual([
      expect.objectContaining({ command: "cancel", outcome: "queued", targetId: late.runId }),
    ]);

    expect(await endRun(run.runId)).toBe(1);
    expect(await endRun(run.runId)).toBe(0);
    const ended = await read(item.itemId);
    expect(ended.projection).toMatchObject({
      state: "review",
      activeOrder: { delivery: "run_ended", released: true, runIds: [run.runId] },
    });
    expect(factsOf(ended, "run_ended")).toHaveLength(1);
  });

  it("ends a send as rejected when its host could not keep the work order, with the host's reason", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);
    const [command] = await commandsByKey(sent.key);
    const failed: AckedCommand = {
      publicId: sent.commandId,
      command: "work_order",
      outcome: "failed",
      payload: command!.payload,
      detail: "could not keep the work order: disk full",
    };
    expect(await acks(r.hostA, [failed])).toBe(1);
    expect(await acks(r.hostA, [failed])).toBe(0);
    const rejected = await read(item.itemId);
    expect(rejected.projection.state).toBe("ready");
    expect(orderIn(rejected, sent.orderId)).toMatchObject({ delivery: "rejected", closed: true, released: true });
    expect(factsOf(rejected, "send_rejected")).toEqual([
      expect.objectContaining({ source: "runtime", data: { reason: "could not keep the work order: disk full" } }),
    ]);
  });

  it("stops a running send with one cancel to its run, and ends the send when the host applies it", async () => {
    const r = await rig();
    const item = await readyItem();
    const sent = await send(item, r);

    // The host takes the work_order command on its poll and says so on the next one.
    const [command] = await commandsByKey(sent.key);
    const received: AckedCommand = { publicId: sent.commandId, command: "work_order", outcome: "received", payload: command!.payload };
    expect(await acks(r.hostA, [received])).toBe(1);
    expect(await acks(r.hostA, [received])).toBe(0);

    await claim(r.hostA, sent.orderPublicId);
    const run = await openRun(r);
    await link(r.hostA, sent.orderPublicId, run.runId);
    const running = await read(item.itemId);
    const stop = { item_id: item.publicId, version: running.version, work_order_id: sent.orderPublicId, reason: "Wrong branch." };
    const first = await inScope((tx) => stopWork(tx, scope, actor, stop));
    expect(first).toMatchObject({ repeat: false, item: { state: "running" }, order: { delivery: "stopping" } });
    expect(first.command_id).not.toBeNull();

    // A retried stop, carrying the version the person read, is a repeat and queues no second cancel.
    const retry = await inScope((tx) => stopWork(tx, scope, actor, stop));
    expect(retry).toMatchObject({ repeat: true, command_id: first.command_id });
    const cancels = await commandsByKey(stopCommandKey(sent.key, run.runId));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      publicId: first.command_id,
      command: "cancel",
      targetKind: "run",
      targetId: run.runId,
      hostId: r.hostA.id,
      sessionId: run.id,
      outcome: "queued",
      reason: "Wrong branch.",
      payload: { session_uuid: run.sessionUuid, work_order: sent.orderPublicId },
    });

    const applied: AckedCommand = { publicId: cancels[0]!.publicId, command: "cancel", outcome: "applied", payload: cancels[0]!.payload };
    expect(await acks(r.hostA, [applied])).toBe(1);
    expect(await acks(r.hostA, [applied])).toBe(0);
    const stopped = await read(item.itemId);
    expect(stopped.projection).toMatchObject({ state: "ready", activeOrder: null });
    expect(orderIn(stopped, sent.orderId)).toMatchObject({ delivery: "stopped", closed: true, released: true });
    expect(factsOf(stopped, "send_delivered")).toEqual([
      expect.objectContaining({ source: "oxagen", orderId: sent.orderId, data: { command_id: sent.commandId } }),
    ]);
    expect(factsOf(stopped, "stopped")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Review and acceptance
  // -------------------------------------------------------------------------

  it("voids an acceptance when the pull request gets a new head, and refuses an acceptance naming the old head", async () => {
    const r = await rig();
    const sent = await inReview(r, { pullRequest: false });
    const { github, deps } = fakeGitHub();

    // A pull request in another repository is not the send's result.
    expect(await recordRunPullRequest(scope, sent.run.sessionUuid, "https://github.com/aintel/marketing/pull/7", deps)).toBe(0);
    // The run's pull request links, and its head, required checks, and checks are read: four facts.
    expect(await recordRunPullRequest(scope, sent.run.sessionUuid, PR_URL, deps)).toBe(4);
    const linked = await read(sent.itemId);
    expect(orderIn(linked, sent.orderId)).toMatchObject({
      pullRequest: { repository: REPOSITORY, number: PR_NUMBER },
      head: SHA1,
      requiredChecks: ["test"],
    });

    const accepted = await acceptWork(deps, scope, actor, acceptance(linked, sent.orderPublicId, SHA1));
    expect(accepted).toMatchObject({ repeat: false, item: { state: "review" }, required_checks: ["test"] });
    expect(orderIn(await read(sent.itemId), sent.orderId).acceptance).toMatchObject({ headSha: SHA1, criteria: CRITERIA });

    // The agent pushes again. GitHub's webhook reports the new head.
    expect(await recordWorkPullRequestDelivery(scope, webhook(SHA2, at(20)), new Date())).toBe(1);
    const moved = await read(sent.itemId);
    expect(moved.projection.state).toBe("review");
    expect(orderIn(moved, sent.orderId)).toMatchObject({ head: SHA2, acceptance: null, staleAcceptance: { headSha: SHA1 } });

    Object.assign(github, { head: SHA2, updatedAt: at(20), checkedAt: at(21) });
    expect(await refusal(acceptWork(deps, scope, actor, acceptance(moved, sent.orderPublicId, SHA1)))).toBe("stale_head");
    expect(factsOf(await read(sent.itemId), "accepted")).toHaveLength(1);

    // The person reviews the new head and accepts it.
    const reread = await read(sent.itemId);
    expect(await acceptWork(deps, scope, actor, acceptance(reread, sent.orderPublicId, SHA2))).toMatchObject({
      item: { state: "review" },
      required_checks: ["test"],
    });
    expect(orderIn(await read(sent.itemId), sent.orderId)).toMatchObject({
      head: SHA2,
      acceptance: { headSha: SHA2 },
      staleAcceptance: { headSha: SHA1 },
    });
  });

  describe("review checks fail closed", () => {
    const refusals: {
      name: string;
      github: Partial<GitHubState>;
      criteria?: string[];
      /** The required checks on record for the head after the refusal. */
      recorded: string[] | null;
      /** Each check's conclusion on record for the head after the refusal. */
      checks: [string, string][];
    }[] = [
      {
        name: "the required checks could not be read",
        github: { required: { ok: false, reason: "rulesets read failed: 404" } },
        recorded: null,
        checks: [["test", "success"]],
      },
      { name: "a required check failed", github: { checks: { test: "failure" } }, recorded: ["test"], checks: [["test", "failure"]] },
      {
        name: "a required check has not reported",
        github: { required: required(["test", "e2e"]) },
        recorded: ["e2e", "test"],
        checks: [["test", "success"]],
      },
      { name: "a required check was skipped", github: { checks: { test: "skipped" } }, recorded: ["test"], checks: [["test", "skipped"]] },
      { name: "a required check was cancelled", github: { checks: { test: "cancelled" } }, recorded: ["test"], checks: [["test", "cancelled"]] },
      { name: "a criterion is not ticked", github: {}, criteria: ["c1"], recorded: ["test"], checks: [["test", "success"]] },
    ];

    it.each(refusals)("refuses Accept when $name, and keeps the evidence it read", async ({ github, criteria, recorded, checks }) => {
      const r = await rig();
      const sent = await inReview(r);
      const { deps } = fakeGitHub(github);
      const before = await read(sent.itemId);
      expect(await refusal(acceptWork(deps, scope, actor, acceptance(before, sent.orderPublicId, SHA1, criteria)))).toBe("not_allowed");

      const after = await read(sent.itemId);
      expect(factsOf(after, "accepted")).toEqual([]);
      expect(after.projection.state).toBe("review");
      const order = orderIn(after, sent.orderId);
      expect(order).toMatchObject({ head: SHA1, acceptance: null, requiredChecks: recorded });
      expect(order.checks.map((check) => [check.name, check.conclusion])).toEqual(checks);
    });

    it("refuses Accept when the read at the press fails, even with an earlier good read of the same head", async () => {
      const r = await rig();
      const sent = await inReview(r);
      const { github, deps } = fakeGitHub();
      const refresh = () => refreshWorkChecks(deps, scope, { item_id: sent.publicId, work_order_id: sent.orderPublicId });
      expect(await refresh()).toMatchObject({ repeat: false, head_sha: SHA1, required_checks: ["test"], unread_reason: null });

      github.required = { ok: false, reason: "rulesets read failed: 404" };
      expect(await refresh()).toMatchObject({ repeat: true, head_sha: SHA1, required_checks: null, unread_reason: "rulesets read failed: 404" });
      const before = await read(sent.itemId);
      expect(orderIn(before, sent.orderId).requiredChecks).toEqual(["test"]);
      expect(await refusal(acceptWork(deps, scope, actor, acceptance(before, sent.orderPublicId, SHA1)))).toBe("not_allowed");
      expect(factsOf(await read(sent.itemId), "accepted")).toEqual([]);
    });

    it("accepts on the person's ticks alone when the base branch requires no check, and records the head", async () => {
      const r = await rig();
      const sent = await inReview(r);
      const { deps } = fakeGitHub({ required: required([]), checks: {} });
      const before = await read(sent.itemId);
      expect(await acceptWork(deps, scope, actor, acceptance(before, sent.orderPublicId, SHA1))).toMatchObject({
        repeat: false,
        item: { state: "review" },
        required_checks: [],
      });
      const after = await read(sent.itemId);
      expect(factsOf(after, "accepted")).toEqual([
        expect.objectContaining({
          source: "person",
          actor: MARCUS,
          orderId: sent.orderId,
          headSha: SHA1,
          briefDigest: before.projection.approvedBrief!.digest,
          data: { criteria: CRITERIA, required_checks: [] },
        }),
      ]);
      expect(orderIn(after, sent.orderId)).toMatchObject({ requiredChecks: [], acceptance: { headSha: SHA1, requiredChecks: [] } });
    });
  });

  it("records an acceptance without merging, and marks the item done when the pull request merges", async () => {
    const r = await rig();
    const sent = await inReview(r);
    const { deps } = fakeGitHub();
    const before = await read(sent.itemId);
    expect(await acceptWork(deps, scope, actor, acceptance(before, sent.orderPublicId, SHA1))).toMatchObject({ item: { state: "review" } });
    const accepted = await read(sent.itemId);
    expect(factsOf(accepted, "merged")).toEqual([]);
    expect(orderIn(accepted, sent.orderId)).toMatchObject({ acceptance: { headSha: SHA1 }, merge: null, done: false, closed: false });

    // A person merges the pull request on GitHub.
    expect(await recordWorkPullRequestDelivery(scope, webhook(SHA1, at(30), { commit: MERGE, at: at(30) }), new Date())).toBe(1);
    const merged = await read(sent.itemId);
    expect(merged.projection.state).toBe("done");
    expect(orderIn(merged, sent.orderId)).toMatchObject({ merge: { headSha: SHA1, mergeCommit: MERGE }, done: true, closed: true });
  });

  it("keeps a merged pull request in review until a person accepts it", async () => {
    const r = await rig();
    const sent = await inReview(r);
    // The merge arrives first: its head and the merge itself.
    expect(await recordWorkPullRequestDelivery(scope, webhook(SHA1, at(30), { commit: MERGE, at: at(30) }), new Date())).toBe(2);
    const merged = await read(sent.itemId);
    expect(merged.projection.state).toBe("review");
    expect(orderIn(merged, sent.orderId)).toMatchObject({ head: SHA1, merge: { mergeCommit: MERGE }, acceptance: null, done: false });

    const { deps } = fakeGitHub({ updatedAt: at(30), merge: { commit: MERGE, at: at(30) } });
    expect(await acceptWork(deps, scope, actor, acceptance(merged, sent.orderPublicId, SHA1))).toMatchObject({ item: { state: "done" } });
    expect(factsOf(await read(sent.itemId), "merged")).toHaveLength(1);
  });

  it("refuses an acceptance made on a version a webhook has since moved, and keeps the read it took", async () => {
    const r = await rig();
    const sent = await inReview(r);
    const before = await read(sent.itemId);
    // The head arrives by webhook after the person read the item.
    expect(await recordWorkPullRequestDelivery(scope, webhook(SHA1, at(10)), new Date())).toBe(1);

    const { deps } = fakeGitHub({ required: required([]), checks: {} });
    expect(await refusal(acceptWork(deps, scope, actor, acceptance(before, sent.orderPublicId, SHA1)))).toBe("stale_version");
    const after = await read(sent.itemId);
    expect(factsOf(after, "accepted")).toEqual([]);
    // The read at the press is recorded before the version check, so it stays.
    expect(orderIn(after, sent.orderId)).toMatchObject({ head: SHA1, requiredChecks: [] });

    // Read again, the same acceptance goes through.
    expect(await acceptWork(deps, scope, actor, acceptance(after, sent.orderPublicId, SHA1))).toMatchObject({ item: { state: "review" } });
  });

  // -------------------------------------------------------------------------
  // Return and resend
  // -------------------------------------------------------------------------

  it("returns a send and sends the item again to the same agent, with the reason in the next first prompt", async () => {
    const r = await rig();
    const sent = await inReview(r);
    const before = await read(sent.itemId);
    const returned = await inScope((tx) =>
      returnWork(tx, scope, actor, { item_id: sent.publicId, version: before.version, work_order_id: sent.orderPublicId, reason: RETURN_REASON, resend: true }, null),
    );
    const secondKey = workOrderKey(sent.publicId, 1, 2);
    expect(secondKey.endsWith(":s2")).toBe(true);
    expect(returned).toMatchObject({
      repeat: false,
      item: { state: "sent" },
      order: { send: 1, delivery: "returned" },
      resent: { send: 2, key: secondKey, delivery: "waiting_for_claim" },
      resend_refused: null,
    });
    const resent = returned.resent!;
    expect(await commandsByKey(secondKey)).toEqual([
      expect.objectContaining({ command: "work_order", hostId: r.hostA.id, outcome: "queued", payload: expect.objectContaining({ work_order: resent.id, key: secondKey }) }),
    ]);
    expect(await commandsByKey(sent.key)).toHaveLength(1);

    const claimed = await claim(r.hostA, resent.id);
    expect(claimed.prompt).toContain(`A person returned the previous send with this reason: ${RETURN_REASON}`);
  });

  it("keeps the return and leaves the item ready when the agent is busy with another send", async () => {
    const r = await rig();
    const sent = await inReview(r);
    // The first run ended, which freed the agent, and another item now holds it.
    const other = await readyItem();
    await send(other, r);

    const before = await read(sent.itemId);
    const returned = await inScope((tx) =>
      returnWork(tx, scope, actor, { item_id: sent.publicId, version: before.version, work_order_id: sent.orderPublicId, reason: RETURN_REASON, resend: true }, null),
    );
    expect(returned).toMatchObject({ repeat: false, item: { state: "ready" }, order: { delivery: "returned" }, resent: null });
    expect(returned.resend_refused).toEqual(expect.any(String));

    const after = await read(sent.itemId);
    expect(after.projection).toMatchObject({ state: "ready", orders: [expect.objectContaining({ send: 1, delivery: "returned" })] });
    expect(await commandsByKey(workOrderKey(sent.publicId, 1, 2))).toEqual([]);
    expect((await read(other.itemId)).projection.state).toBe("sent");
  });

  // -------------------------------------------------------------------------
  // The drain gate
  // -------------------------------------------------------------------------

  describe("the drain gate", () => {
    it("refuses a send to an agent whose host cannot receive work orders yet", async () => {
      const old = await rig([]);
      const item = await readyItem();
      const input = await sendAction(item, old);
      expect(await refusal(inScope((tx) => sendWork(tx, scope, actor, input, null)))).toBe("not_allowed");
      expect((await read(item.itemId)).projection).toMatchObject({ state: "ready", orders: [] });
      expect(await commandsByKey(input.key)).toEqual([]);
    });

    it("holds a work order back from a host that does not advertise work orders, and delivers it once the host does", async () => {
      const old = await rig([]);
      const host = old.hostA;
      const key = `drain-${tag}`;
      const base = Date.now() - 10 * 60_000;
      // Explicit issue times, so the drain's order is fixed.
      const queue = async (command: "work_order" | "pause", minute: number) => {
        const [row] = await withSystemDb((tx) =>
          tx
            .insert(schema.tachoControlCommands)
            .values({
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              hostId: host.id,
              sessionId: null,
              targetKind: "host",
              targetId: host.publicId,
              command,
              payload: command === "work_order" ? { work_order: `wo_drain${tag}`, key, item: `wi_drain${tag}` } : {},
              issuedByUserId: MARCUS,
              issuedAt: new Date(base + minute * 60_000),
              expiresAt: null,
              outcome: "queued",
              idempotencyKey: command === "work_order" ? key : null,
              createdById: MARCUS,
              updatedById: MARCUS,
            })
            .returning({ publicId: schema.tachoControlCommands.publicId }),
        );
        return row!.publicId;
      };
      const drain = (now: Date) =>
        inScope(async (tx) => {
          const [row] = await tx.select().from(schema.tachoHosts).where(eq(schema.tachoHosts.id, host.id));
          return drainCommands(tx as never, row as TachoHostRow, now);
        });
      const delivery = async (publicId: string) => {
        const [row] = await withSystemDb((tx) =>
          tx
            .select({ outcome: schema.tachoControlCommands.outcome, deliveredAt: schema.tachoControlCommands.deliveredAt })
            .from(schema.tachoControlCommands)
            .where(eq(schema.tachoControlCommands.publicId, publicId)),
        );
        return row;
      };

      const order = await queue("work_order", 0);
      const firstPause = await queue("pause", 1);
      const firstPoll = new Date();
      expect((await drain(firstPoll)).map((command) => [command.command, command.id])).toEqual([["pause", firstPause]]);
      expect(await delivery(order)).toEqual({ outcome: "queued", deliveredAt: null });

      // The person updates oxagen on that machine, and its next health report advertises work orders.
      await withSystemDb((tx) => tx.update(schema.tachoHosts).set({ bundleFeatures: [BUNDLE_FEATURE_WORK_ORDERS] }).where(eq(schema.tachoHosts.id, host.id)));
      const secondPause = await queue("pause", 2);
      const secondPoll = new Date(firstPoll.getTime() + 1_000);
      const second = await drain(secondPoll);
      // The first pause is inside its redelivery lease, so only the new rows leave.
      expect(second.map((command) => [command.command, command.id])).toEqual([
        ["work_order", order],
        ["pause", secondPause],
      ]);
      expect(second[0]?.payload).toMatchObject({ work_order: `wo_drain${tag}`, key });
      expect(await delivery(order)).toEqual({ outcome: "sent", deliveredAt: secondPoll });
    });
  });
});
