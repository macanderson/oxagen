// A send's results against a real Postgres (P1-04, ADR-251).
//
// These cases drive the production paths the Inngest steps and ingest call,
// with the database's own row locks and savepoints in play:
//   - run end: `recordRunEnded`, the function `cost/run.sealed` reaches,
//     records the end once, moves the item to review, and replays a pull
//     request the run named before its link landed
//   - ingest link: `linkRunFromIngest` links a run whose frames name its work
//     order, and a refused link leaves the ingest transaction usable
//   - a stop asked for before the run linked reaches the run when it links,
//     and a stop to a run Oxagen cannot reach is refused and records nothing
//   - the hourly sweep: a sealed run whose event was lost gets its end once,
//     an unsealed or freshly sealed run is left alone, and a send whose merge
//     or close delivery was lost gets its pull request read until the merge
//     or close is on record
//
// Each case opens its own workspace, so one case's sweep never reads another
// case's sends. GitHub is a fake each case controls.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import type { GitHubCiChecks, RequiredChecksRead } from "@oxagen/github";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type FactKind, type OrderProjection, isWorkRecordError, workOrderKey } from "@oxagen/work/records";
import { and, eq, inArray } from "drizzle-orm";
import { type SendAction, sendWork, stopWork } from "./actions";
import type { WorkActor } from "./actor";
import { queueRunCancel, stopCommandKey } from "./delivery";
import type { EvidenceReader, PullRequestRead } from "./evidence";
import { type ResultDeps, recordRunEnded, recordRunPullRequest } from "./results";
import { type ClaimingHost, WORK_ORDER_RUN_ATTR, claimWorkOrder, endWorkOrderRuns, linkRunFromIngest, linkWorkOrderRun } from "./runtime";
import { type WorkItemRecord, type WorkScope, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "./store";
import { SWEEP_SEAL_GRACE_MS, type WorkOrderSweepResult, listWorkOrderSweepScopes, sweepWorkOrderResults } from "./sweep";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The work order results test needs DATABASE_URL on CI.");

const SHA1 = "1".repeat(40);
const MERGE = "9".repeat(40);
const REPOSITORY = "aintel/platform";
const PR_NUMBER = 612;
const OTHER_PR = 613;
const STOP_REASON = "The laptop is gone.";
const HOUR = 60 * 60_000;
const NOTHING: WorkOrderSweepResult = { sendsEnded: 0, sendsRead: 0, factsRecorded: 0, failed: 0 };

function prUrl(number: number): string {
  return `https://github.com/${REPOSITORY}/pull/${number}`;
}

/** Minutes after 09:00 UTC on 2026-10-02, a fixed time in the past. */
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

/** How the fake GitHub answers for one pull request. */
interface PullState {
  head: string;
  merge: { commit: string; at: string } | null;
  closed: boolean;
}

/**
 * A GitHub the case controls: each pull request's state by number, and how
 * many times each was read. A number with no state reads as open on SHA1.
 */
function fakeGitHub(states: Record<number, Partial<PullState>> = {}): { reads: Map<number, number>; deps: ResultDeps } {
  const reads = new Map<number, number>();
  const reader: EvidenceReader = {
    async readPullRequest(_scope, _repository, number): Promise<PullRequestRead> {
      reads.set(number, (reads.get(number) ?? 0) + 1);
      const state: PullState = { head: SHA1, merge: null, closed: false, ...states[number] };
      return {
        headSha: state.head,
        baseRef: "main",
        state: state.merge !== null || state.closed ? "closed" : "open",
        merged: state.merge !== null,
        mergeCommitSha: state.merge?.commit ?? null,
        mergedAt: state.merge?.at ?? null,
        updatedAt: at(20),
      };
    },
    async readRequiredChecks(): Promise<RequiredChecksRead> {
      return { ok: true, names: ["test"], sources: { protection: true, rulesets: false } };
    },
    async readChecks(_scope, _repository, sha): Promise<GitHubCiChecks> {
      return {
        sha,
        statuses: [],
        checkRuns: [
          { name: "test", status: "completed", conclusion: "success", detailsUrl: null, startedAt: at(11), completedAt: at(11), appName: null },
        ],
      };
    },
  };
  return { reads, deps: { reader, now: () => new Date() } };
}

describe.skipIf(!enabled)("work order results against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const orgId = crypto.randomUUID();
  const orgNamespace = `r${tag.slice(0, 5)}`;
  /** The operator: he runs the agents and sends the work. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she writes and approves the briefs. */
  const AMARA = crypto.randomUUID();
  const actor: WorkActor = { userId: MARCUS, role: "Owner" };
  let counter = 0;

  /** A workspace of the test org, and the namespace its agent keys carry. */
  interface Space {
    scope: WorkScope;
    namespace: string;
  }

  const inScope = <T>(space: Space, fn: (tx: Tx) => Promise<T>): Promise<T> => runInTenantScope(space.scope, () => withTenantDb(fn));
  const read = (space: Space, itemId: string) => inScope(space, (tx) => readWorkItem(tx, space.scope, itemId));

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@results.test`, status: "active" },
        { id: AMARA, email: `amara-${tag}@results.test`, status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `Results ${tag}`,
        slug: `results-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.tachoControlCommands).where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx.delete(schema.tachoRunPullRequests).where(eq(schema.tachoRunPullRequests.orgId, orgId));
      await tx.delete(schema.tachoSessions).where(eq(schema.tachoSessions.orgId, orgId));
      await tx.delete(schema.tachoHosts).where(eq(schema.tachoHosts.orgId, orgId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.runtimes).where(eq(schema.runtimes.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [MARCUS, AMARA]));
    });
    await closeDatabase();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** A new workspace in the test org. */
  async function workspace(): Promise<Space> {
    counter += 1;
    const space: Space = { scope: { orgId, workspaceId: crypto.randomUUID() }, namespace: `w${counter}` };
    await withSystemDb((tx) =>
      tx.insert(schema.workspaces).values({
        id: space.scope.workspaceId,
        orgId,
        name: `Results ${counter}`,
        slug: `results-${counter}`,
        namespace: space.namespace,
      }),
    );
    return space;
  }

  interface Rig {
    agentPublicId: string;
    agentKey: string;
    /** The agent's own host. The send goes to it, and it claims the order. */
    hostA: ClaimingHost;
    /** A second machine on the same runtime, enrolled for no agent. */
    hostB: ClaimingHost;
  }

  /** A runtime, an agent Marcus operates on it, the agent's host, and a second host on the same runtime. */
  async function rig(space: Space): Promise<Rig> {
    counter += 1;
    const n = counter;
    const { workspaceId } = space.scope;
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
    const agentKey = `${orgNamespace}.${space.namespace}.${slug}`;
    return withSystemDb(async (tx) => {
      const [runtime] = await tx
        .insert(schema.runtimes)
        .values({ orgId, workspaceId, name: `Laptop ${n}`, slug: `laptop-${tag}-${n}`, createdById: MARCUS })
        .returning({ id: schema.runtimes.id });
      const [principal] = await tx
        .insert(schema.principals)
        .values({ orgId, workspaceId, kind: "agent", displayName: `Bot ${n}`, status: "active", parentUserId: MARCUS })
        .returning({ id: schema.principals.id });
      if (!runtime || !principal) throw new Error("fixture insert returned no row");
      const [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId,
          workspaceId,
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
          orgId,
          workspaceId,
          keyPrefix: `oxk_${tag}${n}${suffix}`,
          keyHash: `hash-${tag}-${n}${suffix}`,
          name: `tacho host ${n}${suffix}`,
          scope: { purpose: "tacho_host_v1", host_enrollment_id: publicId },
          createdById: MARCUS,
        });
        await tx.insert(schema.tachoHosts).values({
          id,
          publicId,
          orgId,
          workspaceId,
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
      const hostB = await enroll("b", `${orgNamespace}.${space.namespace}.spare-${n}`, null);
      return { agentPublicId: agent.publicId, agentKey, hostA, hostB };
    });
  }

  interface Item {
    itemId: string;
    publicId: string;
  }

  /** A work item collected from GitHub, its brief saved and approved by Amara, so it is ready to send. */
  async function readyItem(space: Space): Promise<Item> {
    counter += 1;
    const n = counter;
    const { scope } = space;
    const itemId = await inScope(space, async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId,
          workspaceId: scope.workspaceId,
          number: `RES-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:${tag}${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    });
    const collected = await inScope(space, (tx) =>
      recordSource(tx, scope, {
        itemId,
        material: { subject: "Fix invites", description: "The link 500s.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: at(0),
        dedupeKey: `delivery-${n}`,
      }),
    );
    const saved = await inScope(space, (tx) =>
      saveBrief(tx, scope, { itemId, expectedVersion: collected.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
    );
    const approved = await inScope(space, (tx) =>
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

  interface Sent {
    orderId: string;
    orderPublicId: string;
    key: string;
  }

  /** The send a person's page submits for the item as it reads now. */
  async function send(space: Space, item: Item, r: Rig): Promise<Sent> {
    const record = await read(space, item.itemId);
    const approved = record.projection.approvedBrief!;
    const input: SendAction = {
      item_id: item.publicId,
      version: record.version,
      item_revision: record.projection.revision,
      brief_revision: approved.revision,
      brief_digest: approved.digest,
      agent_id: r.agentPublicId,
      key: workOrderKey(item.publicId, approved.revision, record.projection.nextSend),
    };
    const result = await inScope(space, (tx) => sendWork(tx, space.scope, actor, input, null));
    return { orderId: result.write.orderId, orderPublicId: result.write.orderPublicId, key: input.key };
  }

  interface Run {
    /** The session row's id. */
    id: string;
    /** The session's public id (`tse_…`). */
    runId: string;
    sessionUuid: string;
  }

  /** A root session on the agent's host, as ingest opens one. A hostless one is a run Oxagen cannot address. */
  async function openRun(space: Space, r: Rig, options: { hostless?: boolean } = {}): Promise<Run> {
    counter += 1;
    const n = counter;
    const run: Run = { id: crypto.randomUUID(), runId: `tse_${tag}run${n}`, sessionUuid: crypto.randomUUID() };
    await withSystemDb((tx) =>
      tx.insert(schema.tachoSessions).values({
        id: run.id,
        publicId: run.runId,
        orgId,
        workspaceId: space.scope.workspaceId,
        sessionUuid: run.sessionUuid,
        harnessSessionId: `sess-${tag}-${n}`,
        hostId: options.hostless === true ? null : r.hostA.id,
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

  /** The host's `agent_stop`, as ingest records it: the session sealed `ago` milliseconds before now. */
  const sealRun = (run: Run, ago: number) => {
    const sealedAt = new Date(Date.now() - ago);
    return withSystemDb((tx) =>
      tx
        .update(schema.tachoSessions)
        .set({ outcome: "completed", sealSource: "agent_stop", sealedAt, endedAt: sealedAt })
        .where(and(eq(schema.tachoSessions.orgId, orgId), eq(schema.tachoSessions.id, run.id))),
    );
  };

  const claim = (space: Space, host: ClaimingHost, orderPublicId: string) =>
    inScope(space, (tx) => claimWorkOrder(tx, space.scope, host, orderPublicId, new Date()));
  const link = (space: Space, host: ClaimingHost, orderPublicId: string, runId: string) =>
    inScope(space, (tx) => linkWorkOrderRun(tx, space.scope, { host, runId, workOrder: orderPublicId, at: new Date() }));

  /** A ready item sent to the rig's agent, claimed, and a run linked to it. */
  async function running(space: Space, r: Rig): Promise<{ item: Item; sent: Sent; run: Run }> {
    const item = await readyItem(space);
    const sent = await send(space, item, r);
    await claim(space, r.hostA, sent.orderPublicId);
    const run = await openRun(space, r);
    expect(await link(space, r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    return { item, sent, run };
  }

  /** The pull request the run named, recorded on the send the way results.ts records it. */
  function linkPullRequest(space: Space, item: Item, sent: Sent, run: Run, number = PR_NUMBER) {
    return inScope(space, (tx) =>
      appendFacts(tx, space.scope, {
        itemId: item.itemId,
        facts: [
          {
            kind: "pr_linked",
            source: "runtime",
            itemRevision: 1,
            orderId: sent.orderId,
            repository: REPOSITORY,
            prNumber: number,
            runId: run.runId,
            actor: run.runId,
            occurredAt: at(5),
            dedupeKey: `pr_linked:${sent.orderId}:${REPOSITORY}#${number}`,
            data: {},
          },
        ],
      }),
    );
  }

  function orderIn(record: WorkItemRecord, orderId: string): OrderProjection {
    const order = record.projection.orders.find((entry) => entry.orderId === orderId);
    if (order === undefined) throw new Error("The work item has no such send.");
    return order;
  }

  const factsOf = (record: WorkItemRecord, kind: FactKind) => record.facts.filter((fact) => fact.kind === kind);

  const commandsByKey = (space: Space, key: string) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(
          and(
            eq(schema.tachoControlCommands.orgId, orgId),
            eq(schema.tachoControlCommands.workspaceId, space.scope.workspaceId),
            eq(schema.tachoControlCommands.idempotencyKey, key),
          ),
        ),
    );

  // -------------------------------------------------------------------------
  // The run's end
  // -------------------------------------------------------------------------

  it("records a sealed run's end once and moves the item to review", async () => {
    const space = await workspace();
    const r = await rig(space);
    const { item, sent, run } = await running(space, r);
    await sealRun(run, 0);
    const { reads, deps } = fakeGitHub();

    expect(await recordRunEnded(space.scope, run.runId, deps)).toBe(1);
    const record = await read(space, item.itemId);
    expect(record.projection).toMatchObject({ state: "review", activeOrder: { delivery: "run_ended", runIds: [run.runId] } });
    expect(factsOf(record, "run_ended")).toEqual([
      expect.objectContaining({ orderId: sent.orderId, runId: run.runId, data: { outcome: "completed" } }),
    ]);

    // Inngest delivers the event again.
    expect(await recordRunEnded(space.scope, run.runId, deps)).toBe(0);
    expect((await read(space, item.itemId)).facts).toHaveLength(record.facts.length);
    // The run named no pull request, so nothing was read from GitHub.
    expect(reads.size).toBe(0);
  });

  it("records the pull request a run named before its link when the run ends, and reads it once", async () => {
    const space = await workspace();
    const r = await rig(space);
    const item = await readyItem(space);
    const sent = await send(space, item, r);
    await claim(space, r.hostA, sent.orderPublicId);
    const run = await openRun(space, r);
    const { reads, deps } = fakeGitHub();

    // The run names its pull request before its link lands. No send holds the
    // run yet, so the event records nothing, and the row stays on the run.
    await withSystemDb((tx) =>
      tx.insert(schema.tachoRunPullRequests).values({
        orgId,
        workspaceId: space.scope.workspaceId,
        sessionId: run.id,
        url: prUrl(PR_NUMBER),
        provider: "github",
        repository: REPOSITORY,
        number: PR_NUMBER,
      }),
    );
    expect(await recordRunPullRequest(space.scope, run.sessionUuid, prUrl(PR_NUMBER), deps)).toBe(0);
    // A run linked to no send ends with nothing to record.
    expect(await recordRunEnded(space.scope, run.runId, deps)).toBe(0);
    expect(reads.size).toBe(0);

    expect(await link(space, r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    await sealRun(run, 0);
    expect(await recordRunEnded(space.scope, run.runId, deps)).toBe(1);

    const record = await read(space, item.itemId);
    expect(orderIn(record, sent.orderId)).toMatchObject({
      delivery: "run_ended",
      runIds: [run.runId],
      pullRequest: { repository: REPOSITORY, number: PR_NUMBER },
      head: SHA1,
    });
    expect(factsOf(record, "pr_linked")).toEqual([
      expect.objectContaining({ orderId: sent.orderId, runId: run.runId, repository: REPOSITORY, prNumber: PR_NUMBER }),
    ]);
    expect(reads.get(PR_NUMBER)).toBe(1);

    // The event again: no second end, no second link, and no second read.
    expect(await recordRunEnded(space.scope, run.runId, deps)).toBe(0);
    expect(factsOf(await read(space, item.itemId), "pr_linked")).toHaveLength(1);
    expect(reads.get(PR_NUMBER)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The link from ingest
  // -------------------------------------------------------------------------

  it("links a run whose frames name its work order, and keeps the ingest transaction through a refused link", async () => {
    const space = await workspace();
    const r = await rig(space);
    const item = await readyItem(space);
    const sent = await send(space, item, r);
    await claim(space, r.hostA, sent.orderPublicId);
    const stray = await openRun(space, r);
    const naming = (workOrder: string) => [{ attrs: { "oxagen.enforcement_tier": "harness" } }, { attrs: { [WORK_ORDER_RUN_ATTR]: workOrder } }];
    const marker = `MARK-${tag}-${counter}`;

    const inIngest = await inScope(space, async (tx) => {
      // Ingest writes the batch's rows before it links the run.
      await tx.insert(schema.workItems).values({ orgId, workspaceId: space.scope.workspaceId, number: marker, subject: "Marker", origin: "manual" });
      // Frames that name no work order link nothing.
      const unnamed = await linkRunFromIngest(tx, space.scope, r.hostA, stray.runId, [{ attrs: { "oxagen.enforcement_tier": "harness" } }, {}], new Date());
      // The spare host never claimed the order, and a work order that is not
      // in this workspace is not found. Ingest logs each and goes on.
      const spare = await refusal(linkRunFromIngest(tx, space.scope, r.hostB, stray.runId, naming(sent.orderPublicId), new Date()));
      const missing = await refusal(linkRunFromIngest(tx, space.scope, r.hostA, stray.runId, naming(`wo_${tag}missing`), new Date()));
      // The transaction still answers after both refusals.
      const rows = await tx
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.orgId, orgId), eq(schema.workItems.workspaceId, space.scope.workspaceId), eq(schema.workItems.number, marker)));
      return { unnamed, spare, missing, markers: rows.length };
    });
    expect(inIngest).toEqual({ unnamed: null, spare: "forbidden", missing: "not_found", markers: 1 });

    // The ingest transaction committed: the row it wrote before the refusals stays.
    const committed = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.orgId, orgId), eq(schema.workItems.number, marker))),
    );
    expect(committed).toHaveLength(1);
    expect(orderIn(await read(space, item.itemId), sent.orderId)).toMatchObject({ delivery: "claimed", runIds: [] });

    // The agent's own host starts the run, and its frames name the order.
    const run = await openRun(space, r);
    expect(await inScope(space, (tx) => linkRunFromIngest(tx, space.scope, r.hostA, run.runId, naming(sent.orderPublicId), new Date()))).toBe("linked");
    expect(orderIn(await read(space, item.itemId), sent.orderId)).toMatchObject({ delivery: "running", runIds: [run.runId] });
  });

  // -------------------------------------------------------------------------
  // Stops
  // -------------------------------------------------------------------------

  it("sends a stop asked for before the run linked to the run when it links", async () => {
    const space = await workspace();
    const r = await rig(space);
    const item = await readyItem(space);
    const sent = await send(space, item, r);
    await claim(space, r.hostA, sent.orderPublicId);
    const claimed = await read(space, item.itemId);
    const stopped = await inScope(space, (tx) =>
      stopWork(tx, space.scope, actor, { item_id: item.publicId, version: claimed.version, work_order_id: sent.orderPublicId, reason: STOP_REASON }),
    );
    expect(stopped.order).toMatchObject({ delivery: "stopping" });

    // The host had already started the run. It links, and the stop reaches it.
    const run = await openRun(space, r);
    expect(await link(space, r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    expect(await commandsByKey(space, stopCommandKey(sent.key, run.runId))).toEqual([
      expect.objectContaining({ command: "cancel", outcome: "queued", targetKind: "run", targetId: run.runId, reason: STOP_REASON }),
    ]);
    expect(orderIn(await read(space, item.itemId), sent.orderId)).toMatchObject({ delivery: "stopping", runIds: [run.runId] });

    // The link again queues no second stop.
    expect(await link(space, r.hostA, sent.orderPublicId, run.runId)).toBe("repeat");
    expect(await commandsByKey(space, stopCommandKey(sent.key, run.runId))).toHaveLength(1);
  });

  it("refuses to stop a run Oxagen cannot reach, and records no stop", async () => {
    const space = await workspace();
    const r = await rig(space);
    const item = await readyItem(space);
    const sent = await send(space, item, r);
    await claim(space, r.hostA, sent.orderPublicId);
    const cancel = (runId: string) =>
      inScope(space, (tx) =>
        queueRunCancel(tx, space.scope, { workOrder: sent.orderPublicId, orderKey: sent.key, runId, reason: STOP_REASON, userId: MARCUS }),
      );

    // No session carries this run.
    const ghost = `tse_${tag}ghost`;
    expect(await refusal(cancel(ghost))).toBe("not_allowed");
    expect(await commandsByKey(space, stopCommandKey(sent.key, ghost))).toEqual([]);

    // The run's session names no host, so no host would carry the cancel.
    const run = await openRun(space, r, { hostless: true });
    expect(await refusal(cancel(run.runId))).toBe("not_allowed");

    // A person's stop of that run is refused whole: no stop on record, no cancel queued.
    expect(await link(space, r.hostA, sent.orderPublicId, run.runId)).toBe("linked");
    const linked = await read(space, item.itemId);
    const stop = { item_id: item.publicId, version: linked.version, work_order_id: sent.orderPublicId, reason: STOP_REASON };
    expect(await refusal(inScope(space, (tx) => stopWork(tx, space.scope, actor, stop)))).toBe("not_allowed");
    const after = await read(space, item.itemId);
    expect(factsOf(after, "stop_requested")).toEqual([]);
    expect(after.version).toBe(linked.version);
    expect(orderIn(after, sent.orderId)).toMatchObject({ delivery: "running", runIds: [run.runId] });
    expect(await commandsByKey(space, stopCommandKey(sent.key, run.runId))).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The hourly sweep
  // -------------------------------------------------------------------------

  it("records the end of a sealed run whose event was lost, once", async () => {
    const space = await workspace();
    const idle = await workspace();
    const r = await rig(space);
    const { item, sent, run } = await running(space, r);
    // A send no host has claimed holds no run, so its workspace has nothing to sweep.
    await send(idle, await readyItem(idle), await rig(idle));
    // The host sealed the run an hour ago, and `cost/run.sealed` never arrived.
    await sealRun(run, HOUR);

    const scopes = await listWorkOrderSweepScopes();
    expect(scopes).toContainEqual(space.scope);
    expect(scopes).not.toContainEqual(idle.scope);

    const { deps } = fakeGitHub();
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual({ ...NOTHING, sendsEnded: 1 });
    const record = await read(space, item.itemId);
    expect(record.projection).toMatchObject({ state: "review", activeOrder: { delivery: "run_ended", runIds: [run.runId] } });
    expect(factsOf(record, "run_ended")).toEqual([
      expect.objectContaining({ orderId: sent.orderId, runId: run.runId, data: { outcome: "completed" } }),
    ]);

    // The next pass finds nothing left to record.
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual(NOTHING);
    expect((await read(space, item.itemId)).facts).toHaveLength(record.facts.length);
  });

  it("leaves a run that has not sealed, or sealed within the grace, to its own event", async () => {
    const space = await workspace();
    const live = await running(space, await rig(space));
    const fresh = await running(space, await rig(space));
    // Sealed a minute ago: its event is still on its way.
    await sealRun(fresh.run, 60_000);
    const { deps } = fakeGitHub();

    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual(NOTHING);
    expect(orderIn(await read(space, live.item.itemId), live.sent.orderId).delivery).toBe("running");
    expect(orderIn(await read(space, fresh.item.itemId), fresh.sent.orderId).delivery).toBe("running");

    // Once the grace has passed and the event still has not landed, the sweep records it.
    await sealRun(fresh.run, SWEEP_SEAL_GRACE_MS + 60_000);
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual({ ...NOTHING, sendsEnded: 1 });
    expect(orderIn(await read(space, fresh.item.itemId), fresh.sent.orderId).delivery).toBe("run_ended");
    expect(orderIn(await read(space, live.item.itemId), live.sent.orderId).delivery).toBe("running");
  });

  it("reads a send's pull request again when its merge delivery was lost, until the merge is on record", async () => {
    const space = await workspace();
    const { item, sent, run } = await running(space, await rig(space));
    await linkPullRequest(space, item, sent, run);
    const { reads, deps } = fakeGitHub({ [PR_NUMBER]: { merge: { commit: MERGE, at: at(30) } } });

    // The run still runs: its pull request is read when the run ends, not before.
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual(NOTHING);
    expect(reads.size).toBe(0);

    // The run ends. A person merges the pull request, and GitHub's delivery of the merge never arrives.
    expect(await inScope(space, (tx) => endWorkOrderRuns(tx, space.scope, run.runId, "completed", new Date()))).toBe(1);
    const swept = await sweepWorkOrderResults(space.scope, deps);
    expect(swept).toMatchObject({ sendsEnded: 0, sendsRead: 1, failed: 0 });
    expect(swept.factsRecorded).toBeGreaterThan(0);
    const record = await read(space, item.itemId);
    expect(orderIn(record, sent.orderId)).toMatchObject({ merge: { headSha: SHA1, mergeCommit: MERGE } });
    expect(factsOf(record, "merged")).toEqual([expect.objectContaining({ orderId: sent.orderId, data: { merge_commit: MERGE } })]);
    expect(reads.get(PR_NUMBER)).toBe(1);

    // The merge is on record, so the next pass reads nothing.
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual(NOTHING);
    expect(reads.get(PR_NUMBER)).toBe(1);
  });

  it("records a close its delivery lost, and counts a send it cannot record without stopping the pass", async () => {
    const space = await workspace();
    const closed = await running(space, await rig(space));
    const broken = await running(space, await rig(space));
    await linkPullRequest(space, closed.item, closed.sent, closed.run, PR_NUMBER);
    await linkPullRequest(space, broken.item, broken.sent, broken.run, OTHER_PR);
    for (const { run } of [closed, broken]) {
      expect(await inScope(space, (tx) => endWorkOrderRuns(tx, space.scope, run.runId, "completed", new Date()))).toBe(1);
    }
    // One pull request closed without merging. GitHub answers the other with a head that is not a commit.
    const { reads, deps } = fakeGitHub({ [PR_NUMBER]: { closed: true }, [OTHER_PR]: { head: "not-a-commit" } });

    const first = await sweepWorkOrderResults(space.scope, deps);
    expect(first).toMatchObject({ sendsEnded: 0, sendsRead: 1, failed: 1 });
    expect(first.factsRecorded).toBeGreaterThan(0);
    const closedRecord = await read(space, closed.item.itemId);
    expect(orderIn(closedRecord, closed.sent.orderId)).toMatchObject({ prClosed: true, merge: null });
    expect(factsOf(closedRecord, "pr_closed")).toHaveLength(1);
    expect(factsOf(await read(space, broken.item.itemId), "head_observed")).toEqual([]);

    // The close is on record and is not read again. The send that failed is tried again.
    expect(await sweepWorkOrderResults(space.scope, deps)).toEqual({ ...NOTHING, failed: 1 });
    expect(reads.get(PR_NUMBER)).toBe(1);
    expect(reads.get(OTHER_PR)).toBe(2);
  });
});
