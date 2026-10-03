// The Work pages' reads against a real Postgres (P1-05, #5163).
//
// Every item is written through the work record store, the way intake, the
// brief actions, the send, the host, and GitHub write it, and then read back
// through lib/work-read:
//   - list_work_items reduces each item to its row: state, tab, status, wait,
//     the latest send, and cost, with "1 of 2 runs known" when one run has no
//     recorded cost, and no answer read from the send's command row
//   - get_work_item finds an item by its number or its public id, and finds
//     nothing for another workspace's item or a deleted one
//   - the viewer flags follow the same role check the actions make
//   - list_work_targets names why each agent cannot take a send
//   - get_work_outcomes counts a done item and a closed one, and the pilot
//     measures: each send's delivery bucket, the claim time, and each week's
//     intake and full flow
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type FactInput, type FactKind, workOrderKey } from "@oxagen/work/records";
import { and, eq, inArray } from "drizzle-orm";
import { sendWork } from "../work-records/actions";
import type { WorkActor } from "../work-records/actor";
import { type WorkScope, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "../work-records/store";
import { readWorkItemDetail, readWorkItemRows, readWorkOutcomes, readWorkTargets } from "./read";
import { workViewer } from "./viewer";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The Work read test needs DATABASE_URL on CI.");

const SHA1 = "1".repeat(40);
const MERGE = "9".repeat(40);
const REPOSITORY = "aintel/platform";

/** A provider's or a host's time for a fact: now, as the fact arrives. */
const stamp = () => new Date().toISOString();

const DRAFT: BriefDraft = {
  repository: REPOSITORY,
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

describe.skipIf(!enabled)("the Work reads against Postgres", { timeout: 60_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  /** A second workspace in the same org: its items must never reach the first. */
  const other: WorkScope = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const orgNamespace = `r${tag.slice(0, 5)}`;
  const workspaceNamespace = "core";
  /** The operator and an org Owner: he runs the agents and sends the work. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she writes and approves the briefs. She gave no display name. */
  const AMARA = crypto.randomUUID();
  /** A workspace Viewer. */
  const VERA = crypto.randomUUID();
  const actor: WorkActor = { userId: MARCUS, role: "Owner" };
  let counter = 0;

  const inScopeOf = (target: WorkScope) => <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runInTenantScope(target, () => withTenantDb(fn));
  const inScope = inScopeOf(scope);
  const scoped = <T>(fn: () => Promise<T>): Promise<T> => runInTenantScope(scope, fn);
  const contextOf = (userId: string | null, apiKeyId: string | null = null) =>
    ({ orgId: scope.orgId, workspaceId: scope.workspaceId, userId, apiKeyId }) as unknown as CapabilityContext;

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@work-read.test`, displayName: "Marcus Lee", status: "active" },
        { id: AMARA, email: `amara-${tag}@work-read.test`, status: "active" },
        { id: VERA, email: `vera-${tag}@work-read.test`, displayName: "Vera", status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `P105 ${tag}`,
        slug: `p105-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        { id: scope.workspaceId, orgId: scope.orgId, name: "Core", slug: "core", namespace: workspaceNamespace },
        { id: other.workspaceId, orgId: scope.orgId, name: "Lab", slug: "lab", namespace: "lab" },
      ]);
      const [owner] = await tx
        .insert(schema.roles)
        .values({ orgId: scope.orgId, scopeKind: "org", name: "Owner", isSystemDefault: true })
        .returning({ id: schema.roles.id });
      const [viewer] = await tx
        .insert(schema.roles)
        .values({ orgId: scope.orgId, scopeKind: "workspace", name: "Viewer", isSystemDefault: true })
        .returning({ id: schema.roles.id });
      const [marcus] = await tx
        .insert(schema.principals)
        .values({ orgId: scope.orgId, kind: "human", displayName: "Marcus Lee", status: "active", parentUserId: MARCUS })
        .returning({ id: schema.principals.id });
      const [vera] = await tx
        .insert(schema.principals)
        .values({ orgId: scope.orgId, kind: "human", displayName: "Vera", status: "active", parentUserId: VERA })
        .returning({ id: schema.principals.id });
      if (!owner || !viewer || !marcus || !vera) throw new Error("fixture insert returned no row");
      await tx.insert(schema.principalRoleAssignments).values([
        { principalId: marcus.id, roleId: owner.id, orgId: scope.orgId },
        { principalId: vera.id, roleId: viewer.id, orgId: scope.orgId, workspaceId: scope.workspaceId },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const { orgId } = scope;
      await tx.delete(schema.runTotals).where(eq(schema.runTotals.orgId, orgId));
      // Deleting a pull request deletes its work order links.
      await tx.delete(schema.forgePullRequests).where(eq(schema.forgePullRequests.orgId, orgId));
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.tachoControlCommands).where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workTriageCorrections).where(eq(schema.workTriageCorrections.orgId, orgId));
      await tx.delete(schema.workTriageDecisions).where(eq(schema.workTriageDecisions.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.tachoHosts).where(eq(schema.tachoHosts.orgId, orgId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.runtimes).where(eq(schema.runtimes.orgId, orgId));
      await tx.delete(schema.principalRoleAssignments).where(eq(schema.principalRoleAssignments.orgId, orgId));
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.orgId, orgId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [MARCUS, AMARA, VERA]));
    });
    await closeDatabase();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Agent {
    id: string;
    publicId: string;
    name: string;
    runtimeName: string | null;
    hostPublicId: string | null;
  }

  interface AgentOptions {
    /** Put the agent on a runtime. Default true. */
    runtime?: boolean;
    /** Enroll a host for it on that runtime. Default true. */
    host?: boolean;
    /** The features the host advertises. Default: work orders. */
    features?: string[];
    /** When the host last polled. Default: now. */
    lastSeenAt?: Date | null;
    /** The person who operates the agent. Default: Marcus. */
    operator?: string;
    status?: "active" | "archived";
  }

  /** An agent, its runtime, and its enrolled host, each optional. */
  async function agent(name: string, options: AgentOptions = {}): Promise<Agent> {
    counter += 1;
    const n = counter;
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
    return withSystemDb(async (tx) => {
      let runtimeId: string | null = null;
      let runtimeName: string | null = null;
      if (options.runtime !== false) {
        runtimeName = `Laptop ${n}`;
        const [runtime] = await tx
          .insert(schema.runtimes)
          .values({ orgId: scope.orgId, workspaceId: scope.workspaceId, name: runtimeName, slug: `laptop-${tag}-${n}`, createdById: MARCUS })
          .returning({ id: schema.runtimes.id });
        runtimeId = runtime!.id;
      }
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          kind: "agent",
          displayName: name,
          status: "active",
          parentUserId: options.operator ?? MARCUS,
        })
        .returning({ id: schema.principals.id });
      const [row] = await tx
        .insert(schema.agents)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          slug,
          name,
          agentType: "custom",
          status: options.status ?? "active",
          harness: "claude-code",
          principalId: principal!.id,
          runtimeId,
          createdById: MARCUS,
        })
        .returning({ id: schema.agents.id, publicId: schema.agents.publicId });
      if (!row) throw new Error("fixture insert returned no row");
      let hostPublicId: string | null = null;
      if (runtimeId !== null && options.host !== false) {
        hostPublicId = `tch_${tag}${n}`;
        const apiKeyId = crypto.randomUUID();
        await tx.insert(schema.apiKeys).values({
          id: apiKeyId,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          keyPrefix: `oxk_${tag}${n}`,
          keyHash: `hash-${tag}-${n}`,
          name: `tacho host ${n}`,
          scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
          createdById: MARCUS,
        });
        await tx.insert(schema.tachoHosts).values({
          id: crypto.randomUUID(),
          publicId: hostPublicId,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          agentKey: `${orgNamespace}.${workspaceNamespace}.${slug}`,
          agentId: row.id,
          apiKeyId,
          runtimeId,
          hostname: `laptop-${n}`,
          hostnameDigest: "sha256:0",
          platform: "darwin",
          osUser: "marcus",
          osUserDigest: "sha256:0",
          devicePublicKey: `pk-${tag}-${n}`,
          deviceKeyFingerprint: `fp-${tag}-${n}`,
          enrollmentClaims: {},
          enrollmentSignature: "sig",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          status: "active",
          mode: "enforce",
          lastSeenAt: options.lastSeenAt === undefined ? new Date() : options.lastSeenAt,
          bundleFeatures: options.features ?? [BUNDLE_FEATURE_WORK_ORDERS],
        });
      }
      return { id: row.id, publicId: String(row.publicId), name, runtimeName, hostPublicId };
    });
  }

  interface Item {
    itemId: string;
    publicId: string;
    number: string;
  }

  /** A work item collected from GitHub an hour ago, in `target`'s workspace. */
  async function collectedItem(target: WorkScope = scope): Promise<Item> {
    counter += 1;
    const n = counter;
    const number = `WI-${n}`;
    const inTarget = inScopeOf(target);
    const itemId = await inTarget(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: target.orgId,
          workspaceId: target.workspaceId,
          number,
          subject: "Fix invites",
          description: "The link answers 500.",
          origin: "provider",
          providerId: `issue:node:${tag}${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
          sourceRepository: REPOSITORY,
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    });
    const collected = await inTarget((tx) =>
      recordSource(tx, target, {
        itemId,
        material: { subject: "Fix invites", description: "The link answers 500.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        dedupeKey: `delivery-${tag}-${n}`,
      }),
    );
    return { itemId, publicId: collected.publicId, number };
  }

  /** A collected item whose brief Amara saved and, unless asked not to, approved. */
  async function briefedItem(approve = true): Promise<Item> {
    const item = await collectedItem();
    const record = await inScope((tx) => readWorkItem(tx, scope, item.itemId));
    const saved = await inScope((tx) =>
      saveBrief(tx, scope, {
        itemId: item.itemId,
        expectedVersion: record.version,
        itemRevision: 1,
        draft: DRAFT,
        actor: AMARA,
        source: "person",
        actorUserId: AMARA,
      }),
    );
    if (approve) {
      await inScope((tx) =>
        approveBrief(tx, scope, {
          itemId: item.itemId,
          expectedVersion: saved.version,
          itemRevision: 1,
          briefRevision: 1,
          briefDigest: saved.projection.latestBrief!.digest,
          actorUserId: AMARA,
        }),
      );
    }
    return item;
  }

  interface Sent extends Item {
    orderId: string;
    orderPublicId: string;
    key: string;
  }

  /** A ready item sent by Marcus to `target`. */
  async function sentItem(target: Agent): Promise<Sent> {
    const item = await briefedItem();
    const record = await inScope((tx) => readWorkItem(tx, scope, item.itemId));
    const approved = record.projection.approvedBrief!;
    const key = workOrderKey(item.publicId, approved.revision, record.projection.nextSend);
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
          agent_id: target.publicId,
          key,
        },
        null,
      ),
    );
    return { ...item, orderId: result.write.orderId, orderPublicId: result.write.orderPublicId, key };
  }

  /** Append provider and runtime facts to a send, each stamped as it arrives. */
  function record(item: Item, facts: FactInput<FactKind>[]) {
    return inScope((tx) => appendFacts(tx, scope, { itemId: item.itemId, facts }));
  }

  const runtimeFact = (sent: Sent, host: string, kind: "claimed" | "run_linked" | "run_ended", runId?: string): FactInput<FactKind> =>
    ({
      kind,
      source: "runtime",
      itemRevision: 1,
      orderId: sent.orderId,
      actor: host,
      occurredAt: stamp(),
      dedupeKey: `${kind}:${sent.orderId}:${runId ?? "claim"}`,
      ...(runId === undefined ? {} : { runId }),
      data: kind === "claimed" ? { host } : kind === "run_ended" ? { outcome: "completed" } : {},
    }) as FactInput<FactKind>;

  const providerFact = (sent: Sent, kind: "pr_linked" | "head_observed" | "checks_required" | "check_observed" | "merged"): FactInput<FactKind> => {
    const base = { source: "provider" as const, itemRevision: 1, orderId: sent.orderId, actor: "github", occurredAt: stamp(), repository: REPOSITORY, prNumber: 612 };
    switch (kind) {
      case "pr_linked":
        return { ...base, kind, dedupeKey: `pr_linked:${sent.orderId}`, data: {} };
      case "head_observed":
        return { ...base, kind, headSha: SHA1, dedupeKey: `head:${sent.orderId}`, data: {} };
      case "checks_required":
        return { ...base, kind, headSha: SHA1, dedupeKey: `required:${sent.orderId}`, data: { names: ["test"] } };
      case "check_observed":
        return { ...base, kind, headSha: SHA1, dedupeKey: `check:${sent.orderId}`, data: { name: "test", conclusion: "success" as const } };
      case "merged":
        return { ...base, kind, headSha: SHA1, dedupeKey: `merged:${sent.orderId}`, data: { merge_commit: MERGE } };
    }
  };

  /** A sent item whose run ended with a pull request on head SHA1 and a passing required check. */
  async function reviewedItem(target: Agent, runIds: string[]): Promise<Sent> {
    const sent = await sentItem(target);
    const host = target.hostPublicId!;
    await record(sent, [runtimeFact(sent, host, "claimed")]);
    await record(sent, runIds.map((runId) => runtimeFact(sent, host, "run_linked", runId)));
    await record(sent, [providerFact(sent, "pr_linked"), providerFact(sent, "head_observed")]);
    await record(sent, [runtimeFact(sent, host, "run_ended", runIds[0])]);
    await record(sent, [providerFact(sent, "checks_required"), providerFact(sent, "check_observed")]);
    return sent;
  }

  /** A person's decision, as the actions append it. The store replaces the time and key. */
  function decide(item: Item, version: number, fact: FactInput<FactKind>) {
    return inScope((tx) => appendFacts(tx, scope, { itemId: item.itemId, expectedVersion: version, actorUserId: MARCUS, facts: [fact] }));
  }

  /** One run's rollup row. A null cost is a run that reported no usage the rollup could price. */
  function runTotals(runId: string, costMicros: bigint | null) {
    return withSystemDb((tx) =>
      tx.insert(schema.runTotals).values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        runId,
        runSource: "tacho",
        startedAt: new Date(),
        steps: 1,
        modelCalls: 1,
        toolCalls: 0,
        tokens: { input_uncached: 100, output: 20 },
        costMicros,
        costBasis: costMicros === null ? null : "gateway_observed",
        currency: "USD",
        breakdown: { models: [], tools: [] },
        rolledUpAt: new Date(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // The workspace's items, one in each state
  // -------------------------------------------------------------------------

  let agents: Record<"busySent" | "busyRunning" | "free" | "noRuntime" | "noHost" | "outdated" | "notOperator" | "retired", Agent>;
  let items: Record<"fresh" | "triaged" | "ready" | "sent" | "running" | "review" | "done" | "closed" | "deleted" | "elsewhere", Item>;
  const RUN_PRICED = `tse_${tag}p`;
  const RUN_UNPRICED = `tse_${tag}u`;
  const RUN_DONE = `tse_${tag}d`;

  beforeAll(async () => {
    agents = {
      busySent: await agent("A sender"),
      busyRunning: await agent("B runner"),
      free: await agent("C free"),
      noRuntime: await agent("D no runtime", { runtime: false }),
      noHost: await agent("E no host", { host: false }),
      outdated: await agent("F outdated", { features: [], lastSeenAt: null }),
      notOperator: await agent("G Amara's", { operator: AMARA }),
      retired: await agent("H retired", { status: "archived" }),
    };

    const fresh = await collectedItem();
    const triaged = await briefedItem(false);
    const ready = await briefedItem();

    // Sent, and the host took the command without claiming the send.
    const sent = await sentItem(agents.busySent);
    await withSystemDb((tx) =>
      tx
        .update(schema.tachoControlCommands)
        .set({ outcome: "sent", deliveredAt: new Date() })
        .where(and(eq(schema.tachoControlCommands.orgId, scope.orgId), eq(schema.tachoControlCommands.idempotencyKey, sent.key))),
    );

    const running = await sentItem(agents.busyRunning);
    await record(running, [runtimeFact(running, agents.busyRunning.hostPublicId!, "claimed")]);

    // Two runs: the rollup priced one and could not price the other.
    const review = await reviewedItem(agents.free, [RUN_PRICED, RUN_UNPRICED]);
    await runTotals(RUN_PRICED, 1_500_000n);
    await runTotals(RUN_UNPRICED, null);

    // The run ended, so the free agent can take the next send.
    const done = await reviewedItem(agents.free, [RUN_DONE]);
    await record(done, [providerFact(done, "merged")]);
    const beforeAccept = await inScope((tx) => readWorkItem(tx, scope, done.itemId));
    await decide(done, beforeAccept.version, {
      kind: "accepted",
      source: "person",
      itemRevision: 1,
      orderId: done.orderId,
      headSha: SHA1,
      briefDigest: beforeAccept.projection.approvedBrief!.digest,
      actor: MARCUS,
      occurredAt: stamp(),
      dedupeKey: "accepted",
      data: { criteria: ["c1", "c2"], required_checks: [] },
    });

    const closed = await collectedItem();
    const beforeClose = await inScope((tx) => readWorkItem(tx, scope, closed.itemId));
    await decide(closed, beforeClose.version, {
      kind: "closed",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: stamp(),
      dedupeKey: "closed",
      data: { resolution: "declined", reason: "Not this quarter." },
    });

    const deleted = await collectedItem();
    await withSystemDb((tx) =>
      tx.update(schema.workItems).set({ deletedAt: new Date(), deletedById: MARCUS }).where(eq(schema.workItems.id, deleted.itemId)),
    );

    const elsewhere = await collectedItem(other);
    items = { fresh, triaged, ready, sent, running, review, done, closed, deleted, elsewhere };
  });

  // -------------------------------------------------------------------------
  // list_work_items
  // -------------------------------------------------------------------------

  it("reduces each item to its row: state, tab, status, and what it waits for", async () => {
    const page = await scoped(() => readWorkItemRows(scope, 500));
    workItemsList.output.parse({ ...page, viewer: { can_control: false, can_approve: false } });
    expect(page.truncated).toBe(false);
    const rowOf = (item: Item) => page.items.find((row) => row.id === item.publicId);

    expect(rowOf(items.fresh)).toMatchObject({ state: "new", tab: "inbox", status: "triaging", wait: { kind: "triaging" }, send: null });
    expect(rowOf(items.triaged)).toMatchObject({
      state: "triaged",
      tab: "inbox",
      status: "brief_to_approve",
      wait: { kind: "brief_to_approve", from_triage: false, reopened: null },
    });
    expect(rowOf(items.ready)).toMatchObject({ state: "ready", tab: "inbox", status: "ready", wait: { kind: "ready", last_send: null } });
    expect(rowOf(items.sent)).toMatchObject({
      state: "sent",
      tab: "running",
      status: "no_answer",
      wait: { kind: "no_answer", runtime: agents.busySent.runtimeName },
      send: { id: (items.sent as Sent).orderPublicId, no_answer: true, delivery: "waiting_for_claim", agent: { name: "A sender" } },
    });
    expect(rowOf(items.sent)?.wait).toHaveProperty("last_poll_at", expect.any(String));
    expect(rowOf(items.running)).toMatchObject({ state: "running", tab: "running", status: "running", wait: { kind: "running" } });
    expect(rowOf(items.review)).toMatchObject({
      state: "review",
      tab: "review",
      status: "in_review",
      wait: { kind: "ready_for_review", head: SHA1 },
      send: { checks: "passing", gate: { open: true, block: null, detail: null }, pull_request: { repository: REPOSITORY, number: 612 } },
      cost: { runs: 2, known_runs: 1, total: { micros: "1500000", currency: "USD" } },
    });
    expect(rowOf(items.done)).toMatchObject({
      state: "done",
      tab: "done",
      status: "done",
      wait: { kind: "done", accepted: { by: "Marcus Lee", head: SHA1 } },
    });
    expect(rowOf(items.done)?.finished_at).not.toBeNull();
    expect(rowOf(items.closed)).toMatchObject({
      state: "closed",
      tab: "done",
      status: "closed",
      wait: { kind: "closed", resolution: "declined", by: "Marcus Lee", reason: "Not this quarter." },
    });
  });

  it("leaves out deleted items and another workspace's items", async () => {
    const page = await scoped(() => readWorkItemRows(scope, 500));
    const ids = page.items.map((row) => row.id);
    expect(ids).not.toContain(items.deleted.publicId);
    expect(ids).not.toContain(items.elsewhere.publicId);
    expect(ids).toHaveLength(8);
  });

  it("answers the newest items first and says when there were more", async () => {
    const page = await scoped(() => readWorkItemRows(scope, 2));
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // get_work_item
  // -------------------------------------------------------------------------

  it("reads one item by its number and by its public id", async () => {
    const byNumber = await scoped(() => readWorkItemDetail(scope, items.review.number));
    const byId = await scoped(() => readWorkItemDetail(scope, items.review.publicId));
    expect(byNumber).not.toBeNull();
    expect(byId?.item.id).toBe(items.review.publicId);
    expect(byNumber?.item.id).toBe(items.review.publicId);
    const detail = workItemGet.output.parse({ ...byNumber!, viewer: { can_control: true, can_approve: true } });

    expect(detail.item.source_revisions).toHaveLength(1);
    expect(detail.item.description).toBe("The link answers 500.");
    expect(detail.brief.state).toBe("approved");
    expect(detail.brief.revisions[0]).toMatchObject({ revision: 1, author: `amara-${tag}@work-read.test`, approved: { by: `amara-${tag}@work-read.test` } });
    expect(detail.next_send).toBeNull();
    expect(detail.sends).toHaveLength(1);
    const send = detail.sends[0]!;
    expect(send).toMatchObject({
      id: (items.review as Sent).orderPublicId,
      operator: "Marcus Lee",
      mandate_id: null,
      host: { name: expect.stringMatching(/^laptop-/) },
      checks_word: "passing",
      cost: { runs: 2, known_runs: 1, total: { micros: "1500000", currency: "USD" } },
    });
    expect(send.runs).toEqual(
      expect.arrayContaining([
        { id: RUN_PRICED, cost: { micros: "1500000", currency: "USD" }, basis: "gateway_observed", tier: null },
        { id: RUN_UNPRICED, cost: null, basis: null, tier: null },
      ]),
    );
    expect(detail.history.find((entry) => entry.kind === "claimed")?.actor).toMatch(/^laptop-/);
    expect(detail.history.find((entry) => entry.kind === "brief_approved")?.actor).toBe(`amara-${tag}@work-read.test`);
  });

  it("lists each send's pull requests from the forge store, by link and by the pr_linked fact", async () => {
    const review = items.review as Sent;
    const pull = (target: WorkScope, number: number, over: Partial<typeof schema.forgePullRequests.$inferInsert> = {}) => ({
      orgId: target.orgId,
      workspaceId: target.workspaceId,
      provider: "github",
      host: "github.com",
      providerRepositoryId: "4242",
      repository: REPOSITORY,
      number,
      url: `https://github.com/${REPOSITORY}/pull/${number}`,
      title: `Change ${number}`,
      state: "open",
      headSha: SHA1,
      stateSeenAt: new Date("2026-10-03T10:00:00.000Z"),
      ...over,
    });
    await withSystemDb(async (tx) => {
      const [linked] = await tx
        .insert(schema.forgePullRequests)
        .values(pull(scope, 700, { state: "merged", stateSeenAt: new Date("2026-10-03T11:00:00.000Z") }))
        .returning({ id: schema.forgePullRequests.id });
      if (!linked) throw new Error("fixture insert returned no row");
      await tx.insert(schema.forgePullRequestWorkOrders).values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pullRequestId: linked.id,
        workOrderId: review.orderId,
      });
      // #612 is the one the send's pr_linked fact names. The same key in
      // another workspace is that workspace's pull request.
      await tx.insert(schema.forgePullRequests).values([pull(scope, 612, { draft: true }), pull(other, 612, { state: "closed" })]);
    });

    const detail = await scoped(() => readWorkItemDetail(scope, review.publicId));
    const parsed = workItemGet.output.parse({ ...detail!, viewer: { can_control: true, can_approve: true } });
    const send = parsed.sends[0]!;
    expect(send.pull_requests.map((entry) => [entry.number, entry.state])).toEqual([
      [700, "merged"],
      [612, "draft"],
    ]);
    expect(send.pull_requests[0]?.id).toMatch(/^fpr_/);
    // The facts still decide the pull request acceptance is judged on.
    expect(send.pull_request).toMatchObject({ number: 612, head: SHA1 });
    expect(send.checks_word).toBe("passing");

    const page = await scoped(() => readWorkItemRows(scope, 500));
    const row = page.items.find((entry) => entry.id === review.publicId);
    expect(row?.send?.pull_requests.map((entry) => entry.number)).toEqual([700, 612]);
    expect(page.items.find((entry) => entry.id === items.running.publicId)?.send?.pull_requests).toEqual([]);
  });

  it("finds no item from another workspace, and no deleted item", async () => {
    expect(await scoped(() => readWorkItemDetail(scope, items.elsewhere.publicId))).toBeNull();
    expect(await scoped(() => readWorkItemDetail(scope, items.elsewhere.number))).toBeNull();
    expect(await scoped(() => readWorkItemDetail(scope, items.deleted.publicId))).toBeNull();
  });

  it("fixes the next send's key on a ready item", async () => {
    const detail = await scoped(() => readWorkItemDetail(scope, items.ready.publicId));
    expect(detail?.next_send).toEqual({ send: 1, key: workOrderKey(items.ready.publicId, 1, 1) });
  });

  // -------------------------------------------------------------------------
  // The viewer
  // -------------------------------------------------------------------------

  it("lets an org Owner control and approve, and a workspace Viewer neither", async () => {
    expect(await scoped(() => workViewer(contextOf(MARCUS)))).toEqual({ can_control: true, can_approve: true });
    expect(await scoped(() => workViewer(contextOf(VERA)))).toEqual({ can_control: false, can_approve: false });
    expect(await scoped(() => workViewer(contextOf(null, crypto.randomUUID())))).toEqual({ can_control: false, can_approve: false });
  });

  // -------------------------------------------------------------------------
  // list_work_targets
  // -------------------------------------------------------------------------

  it("names why each agent cannot take a send", async () => {
    const targets = await scoped(() => readWorkTargets(scope, MARCUS, new Date()));
    workTargetsList.output.parse({ agents: targets });
    const of = (target: Agent) => targets.find((entry) => entry.id === target.publicId);

    expect(of(agents.retired)).toBeUndefined();
    expect(of(agents.free)).toMatchObject({
      can_take: true,
      reason: null,
      operates: true,
      busy_with: null,
      quiet: false,
      runtime: { name: agents.free.runtimeName, tier: "harness" },
      host: { takes_work_orders: true },
    });
    expect(of(agents.free)?.runtime?.id).toMatch(/^rtm_/);
    expect(of(agents.busySent)).toMatchObject({
      can_take: false,
      reason: "busy",
      busy_with: { id: items.sent.publicId, number: items.sent.number },
    });
    expect(of(agents.busyRunning)).toMatchObject({ reason: "busy", busy_with: { id: items.running.publicId } });
    expect(of(agents.noRuntime)).toMatchObject({ can_take: false, reason: "no_runtime", runtime: null, host: null, quiet: false });
    expect(of(agents.noHost)).toMatchObject({ can_take: false, reason: "no_host", host: null });
    expect(of(agents.outdated)).toMatchObject({
      can_take: false,
      reason: "host_outdated",
      quiet: true,
      host: { takes_work_orders: false, last_poll_at: null },
    });
    expect(of(agents.notOperator)).toMatchObject({ can_take: false, reason: "not_operator", operates: false });
  });

  it("reads operation for the person reading", async () => {
    const targets = await scoped(() => readWorkTargets(scope, AMARA, new Date()));
    expect(targets.find((entry) => entry.id === agents.free.publicId)).toMatchObject({ reason: "not_operator", operates: false });
    expect(targets.find((entry) => entry.id === agents.notOperator.publicId)).toMatchObject({ can_take: true, operates: true });
  });

  // -------------------------------------------------------------------------
  // get_work_outcomes
  // -------------------------------------------------------------------------

  it("counts the done item and the closed one", async () => {
    const outcomes = workOutcomesGet.output.parse(await scoped(() => readWorkOutcomes(scope, 30, new Date())));
    expect(outcomes.accepted_merged).toBe(1);
    expect(outcomes.returned).toBe(0);
    expect(outcomes.closed).toEqual({ cancelled: 0, declined: 1, duplicate: 0 });
    expect(outcomes.lead_time.sample).toBe(1);
    expect(outcomes.lead_time.median_hours).toBeGreaterThan(0.9);
    expect(outcomes.touches).toMatchObject({ brief_approvals: 1, acceptances: 1, returns: 0, per_item: 2 });
    expect(outcomes.cost).toEqual({ runs: 1, known_runs: 0, total: null });
    expect(outcomes.reopens).toEqual({ cohort: 0, reopened: 0, waiting: 1 });
    expect(outcomes.weeks.reduce((sum, week) => sum + week.accepted_merged, 0)).toBe(1);
  });

  it("counts the pilot measures: each send's delivery, the claim time, and each week's intake", async () => {
    const outcomes = workOutcomesGet.output.parse(await scoped(() => readWorkOutcomes(scope, 30, new Date())));
    expect(outcomes.truncated).toBe(false);
    // Four sends went out: to the sent, running, review, and done items. A
    // runtime claimed the last three, and the first still waits.
    expect(outcomes.delivery).toMatchObject({ sends: 4, claimed: 3, rejected: 0, withdrawn: 0, waiting: 1 });
    expect(outcomes.delivery.claim_minutes.sample).toBe(3);
    expect(outcomes.delivery.claim_minutes.median).toBeGreaterThanOrEqual(0);
    expect(outcomes.delivery.claim_minutes.p90).toBeGreaterThanOrEqual(0);
    // Sum across the weeks: a run just after midnight on a Monday puts the
    // items' collection and their sends in different weeks.
    const total = (key: "entered" | "sent") => outcomes.weeks.reduce((sum, week) => sum + week[key], 0);
    // The eight live items entered Work. The deleted item and the other
    // workspace's item do not count.
    expect(total("entered")).toBe(8);
    expect(total("sent")).toBe(4);
    // Only the week the done item finished in used the full flow.
    const fullFlow = outcomes.weeks.filter((week) => week.full_flow);
    expect(fullFlow).toHaveLength(1);
    expect(fullFlow[0]?.accepted_merged).toBe(1);
  });
});
