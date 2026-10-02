// The Work list reads fewer facts and answers the same rows (#5181).
//
// list_work_items used to load every fact of the newest 500 items. A busy item
// holds a check fact for every check on every head commit its pull request
// had, and only the checks on a send's current head reach the projection.
// listFactsByItem (read.ts) now reads every other fact first, reduces, and then
// reads only the checks on each send's current head. This file proves on
// Postgres that nothing a person sees changes:
//   - every list row equals the row get_work_item derives from the store's
//     full read of the item, which reduces every fact the way the list did
//     before (detail.item is the row plus three detail fields)
//   - every listed projection equals the store's full reduction
//   - at 500 items of 50 facts each, the list reads at most 26 facts an item
//     and still answers each row from the current head's checks
//
// The fixtures include the cases a cruder cut would get wrong: older heads
// with a failed check under a passing current head, a current head failing
// under an older passing one, a returned send and a done send whose checks
// word the row still shows, and a returned send that was sent again.
//
// The budget counts facts, not milliseconds. CI runners vary in speed, and the
// repository asserts no wall-time budget anywhere. Facts read are what the
// change moves.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, type CheckConclusion, type FactInput, type FactKind, workOrderKey } from "@oxagen/work/records";
import { and, count, eq, inArray } from "drizzle-orm";
import { returnWork, sendWork } from "../work-records/actions";
import type { WorkActor } from "../work-records/actor";
import { type WorkScope, type WorkWrite, appendFacts, approveBrief, readWorkItem, recordSource, saveBrief } from "../work-records/store";
import { listFactsByItem, readWorkItemDetail, readWorkItemRows } from "./read";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The Work list test needs DATABASE_URL on CI.");

const [SHA1, SHA2, SHA3, SHA4] = ["1", "2", "3", "4"].map((digit) => digit.repeat(40)) as [string, string, string, string];
const MERGE = "9".repeat(40);
const REPOSITORY = "aintel/platform";
const PR = 612;

/** The bulk case: 500 items of 50 facts each. */
const BULK_ITEMS = 500;
const BULK_FACTS_PER_ITEM = 50;
/**
 * What the list may read of a bulk item: its 16 facts that are not checks
 * (source, brief, approval, send, claim, run, pull request, four heads, four
 * required-check lists, run end) and the 10 check facts on its current head.
 */
const LIST_FACTS_BUDGET_PER_ITEM = 26;
/** Bulk items are written by this many agents at once, one send each at a time. */
const BULK_LANES = 4;

const DRAFT: BriefDraft = {
  repository: REPOSITORY,
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

/** A provider's or a host's time for a fact: now, and later than every time handed out before. */
let lastTick = 0;
function stamp(): string {
  lastTick = Math.max(lastTick + 1, Date.now());
  return new Date(lastTick).toISOString();
}

describe.skipIf(!enabled)("the Work list against Postgres", { timeout: 120_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  /** A second workspace in the same org for the bulk case, so its 500 items stay apart. */
  const bulk: WorkScope = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const orgNamespace = `l${tag.slice(0, 5)}`;
  /** The operator: he runs the agents, sends the work, and accepts it. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she writes and approves the briefs. */
  const AMARA = crypto.randomUUID();
  const actor: WorkActor = { userId: MARCUS, role: "Owner" };
  let counter = 0;

  const inScopeOf =
    (target: WorkScope) =>
    <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      runInTenantScope(target, () => withTenantDb(fn));
  const scopedOf =
    (target: WorkScope) =>
    <T>(fn: () => Promise<T>): Promise<T> =>
      runInTenantScope(target, fn);

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@work-list.test`, displayName: "Marcus Lee", status: "active" },
        { id: AMARA, email: `amara-${tag}@work-list.test`, displayName: "Amara", status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `P105 list ${tag}`,
        slug: `p105-list-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values([
        { id: scope.workspaceId, orgId: scope.orgId, name: "Core", slug: "core", namespace: "core" },
        { id: bulk.workspaceId, orgId: scope.orgId, name: "Bulk", slug: "bulk", namespace: "bulk" },
      ]);
    });
  }, 30_000);

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const { orgId } = scope;
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.tachoControlCommands).where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
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
  }, 120_000); // The bulk case leaves about 25,000 facts and 500 items to delete.

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Agent {
    publicId: string;
    hostPublicId: string;
  }

  /** An agent Marcus operates, on its own runtime, with an enrolled host that takes work orders. */
  async function agent(target: WorkScope, name: string): Promise<Agent> {
    counter += 1;
    const n = counter;
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
    const workspaceNamespace = target.workspaceId === bulk.workspaceId ? "bulk" : "core";
    return withSystemDb(async (tx) => {
      const [runtime] = await tx
        .insert(schema.runtimes)
        .values({ orgId: target.orgId, workspaceId: target.workspaceId, name: `Laptop ${n}`, slug: `laptop-${tag}-${n}`, createdById: MARCUS })
        .returning({ id: schema.runtimes.id });
      const [principal] = await tx
        .insert(schema.principals)
        .values({ orgId: target.orgId, workspaceId: target.workspaceId, kind: "agent", displayName: name, status: "active", parentUserId: MARCUS })
        .returning({ id: schema.principals.id });
      const [row] = await tx
        .insert(schema.agents)
        .values({
          orgId: target.orgId,
          workspaceId: target.workspaceId,
          slug,
          name,
          agentType: "custom",
          status: "active",
          harness: "claude-code",
          principalId: principal!.id,
          runtimeId: runtime!.id,
          createdById: MARCUS,
        })
        .returning({ id: schema.agents.id, publicId: schema.agents.publicId });
      if (!row) throw new Error("fixture insert returned no row");
      const hostPublicId = `tch_${tag}${n}`;
      const apiKeyId = crypto.randomUUID();
      await tx.insert(schema.apiKeys).values({
        id: apiKeyId,
        orgId: target.orgId,
        workspaceId: target.workspaceId,
        keyPrefix: `oxk_${tag}${n}`,
        keyHash: `hash-${tag}-${n}`,
        name: `tacho host ${n}`,
        scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
        createdById: MARCUS,
      });
      await tx.insert(schema.tachoHosts).values({
        id: crypto.randomUUID(),
        publicId: hostPublicId,
        orgId: target.orgId,
        workspaceId: target.workspaceId,
        agentKey: `${orgNamespace}.${workspaceNamespace}.${slug}`,
        agentId: row.id,
        apiKeyId,
        runtimeId: runtime!.id,
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
        lastSeenAt: new Date(),
        bundleFeatures: [BUNDLE_FEATURE_WORK_ORDERS],
      });
      return { publicId: String(row.publicId), hostPublicId };
    });
  }

  interface Sent {
    itemId: string;
    publicId: string;
    orderId: string;
    orderPublicId: string;
    write: WorkWrite;
  }

  /**
   * In one transaction: a work item collected from GitHub, its brief saved by
   * Amara and approved, and the item sent by Marcus to `target`.
   */
  async function sendNewItem(tx: Tx, scopeOf: WorkScope, target: Agent): Promise<Sent> {
    counter += 1;
    const n = counter;
    const [row] = await tx
      .insert(schema.workItems)
      .values({
        orgId: scopeOf.orgId,
        workspaceId: scopeOf.workspaceId,
        number: `WI-${n}`,
        subject: "Fix invites",
        description: "The link answers 500.",
        origin: "provider",
        providerId: `issue:node:${tag}${n}`,
        sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        sourceRepository: REPOSITORY,
      })
      .returning({ id: schema.workItems.id });
    const itemId = row!.id;
    const collected = await recordSource(tx, scopeOf, {
      itemId,
      material: { subject: "Fix invites", description: "The link answers 500.", labels: ["bug"] },
      source: "provider",
      actor: "github",
      occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      dedupeKey: `delivery-${tag}-${n}`,
    });
    const saved = await saveBrief(tx, scopeOf, {
      itemId,
      expectedVersion: collected.version,
      itemRevision: 1,
      draft: DRAFT,
      actor: AMARA,
      source: "person",
      actorUserId: AMARA,
    });
    const approved = await approveBrief(tx, scopeOf, {
      itemId,
      expectedVersion: saved.version,
      itemRevision: 1,
      briefRevision: 1,
      briefDigest: saved.projection.latestBrief!.digest,
      actorUserId: AMARA,
    });
    const brief = approved.projection.approvedBrief!;
    const result = await sendWork(
      tx,
      scopeOf,
      actor,
      {
        item_id: collected.publicId,
        version: approved.version,
        item_revision: approved.projection.revision,
        brief_revision: brief.revision,
        brief_digest: brief.digest,
        agent_id: target.publicId,
        key: workOrderKey(collected.publicId, brief.revision, approved.projection.nextSend),
      },
      null,
    );
    return { itemId, publicId: collected.publicId, orderId: result.write.orderId, orderPublicId: result.write.orderPublicId, write: result.write };
  }

  type Fact = FactInput<FactKind>;

  const runtimeFact = (orderId: string, host: string, kind: "claimed" | "run_linked" | "run_ended", runId?: string): Fact =>
    ({
      kind,
      source: "runtime",
      itemRevision: 1,
      orderId,
      actor: host,
      occurredAt: stamp(),
      dedupeKey: `${kind}:${orderId}`,
      ...(runId === undefined ? {} : { runId }),
      data: kind === "claimed" ? { host } : kind === "run_ended" ? { outcome: "completed" } : {},
    }) as Fact;

  const providerFact = (orderId: string, kind: FactKind, dedupeKey: string, data: Record<string, unknown>, headSha?: string): Fact =>
    ({
      kind,
      source: "provider",
      itemRevision: 1,
      orderId,
      actor: "github",
      occurredAt: stamp(),
      repository: REPOSITORY,
      prNumber: PR,
      dedupeKey,
      data,
      ...(headSha === undefined ? {} : { headSha }),
    }) as Fact;

  /** A head commit, the checks its base branch requires, and each check's observations in order. */
  function headFacts(orderId: string, sha: string, required: string[], observations: [string, CheckConclusion][]): Fact[] {
    return [
      providerFact(orderId, "head_observed", `head:${sha}`, {}, sha),
      providerFact(orderId, "checks_required", `required:${sha}`, { names: required }, sha),
      ...observations.map(([name, conclusion], index) => providerFact(orderId, "check_observed", `check:${sha}:${name}:${index}`, { name, conclusion }, sha)),
    ];
  }

  /** Claimed, run linked, and a pull request: what every send in review starts with. */
  const started = (sent: Sent, target: Agent, runId: string): Fact[] => [
    runtimeFact(sent.orderId, target.hostPublicId, "claimed"),
    runtimeFact(sent.orderId, target.hostPublicId, "run_linked", runId),
    providerFact(sent.orderId, "pr_linked", "pr_linked", {}),
  ];

  const append = (tx: Tx, scopeOf: WorkScope, sent: Sent, facts: Fact[]) => appendFacts(tx, scopeOf, { itemId: sent.itemId, facts });

  // -------------------------------------------------------------------------
  // The workspace's items, each a case a cruder cut would get wrong
  // -------------------------------------------------------------------------

  const inScope = inScopeOf(scope);
  const scoped = scopedOf(scope);
  let items: Record<"threeHeads" | "failingNow" | "returned" | "resent" | "done" | "running", Sent>;

  beforeAll(async () => {
    const run = (letter: string) => `tse_${tag}${letter}`;

    // Review, three heads: the older two each failed a check, the current one passes.
    const a1 = await agent(scope, "A three heads");
    const threeHeads = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a1);
      await append(tx, scope, sent, [
        ...started(sent, a1, run("a")),
        ...headFacts(sent.orderId, SHA1, ["lint", "test"], [["lint", "failure"], ["test", "success"]]),
        ...headFacts(sent.orderId, SHA2, ["lint", "test"], [["lint", "pending"], ["lint", "failure"]]),
        ...headFacts(sent.orderId, SHA3, ["lint", "test"], [["lint", "pending"], ["test", "pending"], ["lint", "success"], ["test", "success"]]),
        runtimeFact(sent.orderId, a1.hostPublicId, "run_ended", run("a")),
      ]);
      return sent;
    });

    // Review, current head failing under an older head that passed. The
    // missing required check sorts before the failed one.
    const a2 = await agent(scope, "B failing now");
    const failingNow = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a2);
      await append(tx, scope, sent, [
        ...started(sent, a2, run("b")),
        ...headFacts(sent.orderId, SHA1, ["lint", "test"], [["lint", "success"], ["test", "success"]]),
        ...headFacts(sent.orderId, SHA2, ["lint", "test"], [["test", "failure"]]),
        runtimeFact(sent.orderId, a2.hostPublicId, "run_ended", run("b")),
      ]);
      return sent;
    });

    // Returned to ready. The row still shows the returned send and its checks word.
    const a3 = await agent(scope, "C returned");
    const returned = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a3);
      const ended = await append(tx, scope, sent, [
        ...started(sent, a3, run("c")),
        ...headFacts(sent.orderId, SHA1, ["test"], [["test", "success"]]),
        ...headFacts(sent.orderId, SHA2, ["test"], [["test", "failure"]]),
        runtimeFact(sent.orderId, a3.hostPublicId, "run_ended", run("c")),
      ]);
      await returnWork(
        tx,
        scope,
        actor,
        { item_id: sent.publicId, version: ended.version, work_order_id: sent.orderPublicId, reason: "The test fails.", resend: false },
        null,
      );
      return sent;
    });

    // Returned and sent again: the second send waits for its claim, and the
    // first keeps its checks in the projection.
    const a4 = await agent(scope, "D resent");
    const resent = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a4);
      const ended = await append(tx, scope, sent, [
        ...started(sent, a4, run("d")),
        ...headFacts(sent.orderId, SHA1, ["test"], [["test", "failure"]]),
        ...headFacts(sent.orderId, SHA2, ["test"], [["test", "success"]]),
        runtimeFact(sent.orderId, a4.hostPublicId, "run_ended", run("d")),
      ]);
      const back = await returnWork(
        tx,
        scope,
        actor,
        { item_id: sent.publicId, version: ended.version, work_order_id: sent.orderPublicId, reason: "Wrong approach.", resend: true },
        null,
      );
      if (back.resent === null) throw new Error(`The resend was refused: ${back.resend_refused ?? "no reason"}`);
      return sent;
    });

    // Done: merged on its second head, whose checks passed, and accepted there.
    const a5 = await agent(scope, "E done");
    const done = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a5);
      const merged = await append(tx, scope, sent, [
        ...started(sent, a5, run("e")),
        ...headFacts(sent.orderId, SHA1, ["test"], [["test", "failure"]]),
        ...headFacts(sent.orderId, SHA2, ["test"], [["test", "pending"], ["test", "success"]]),
        runtimeFact(sent.orderId, a5.hostPublicId, "run_ended", run("e")),
        providerFact(sent.orderId, "merged", "merged", { merge_commit: MERGE }, SHA2),
      ]);
      await appendFacts(tx, scope, {
        itemId: sent.itemId,
        expectedVersion: merged.version,
        actorUserId: MARCUS,
        facts: [
          {
            kind: "accepted",
            source: "person",
            itemRevision: 1,
            orderId: sent.orderId,
            headSha: SHA2,
            briefDigest: merged.projection.approvedBrief!.digest,
            actor: MARCUS,
            occurredAt: stamp(),
            dedupeKey: "accepted",
            data: { criteria: ["c1", "c2"], required_checks: [] },
          },
        ],
      });
      return sent;
    });

    // Running, with no head yet: no check to read.
    const a6 = await agent(scope, "F running");
    const running = await inScope(async (tx) => {
      const sent = await sendNewItem(tx, scope, a6);
      await append(tx, scope, sent, [runtimeFact(sent.orderId, a6.hostPublicId, "claimed")]);
      return sent;
    });

    items = { threeHeads, failingNow, returned, resent, done, running };
  }, 120_000);

  // -------------------------------------------------------------------------
  // The rows
  // -------------------------------------------------------------------------

  it("answers every row the full reduction of every fact answers", async () => {
    const page = await scoped(() => readWorkItemRows(scope, 500));
    workItemsList.output.parse({ ...page, viewer: { can_control: false, can_approve: false } });
    expect(page.items).toHaveLength(Object.keys(items).length);
    for (const row of page.items) {
      // get_work_item reads every fact through the store and reduces them, as
      // the list did before #5181. Its item is the row plus three fields.
      const detail = await scoped(() => readWorkItemDetail(scope, row.id));
      expect(detail, `get_work_item found ${row.number}`).not.toBeNull();
      const { description: _description, source_revisions: _sources, collector: _collector, ...expected } = detail!.item;
      expect(row, `the row of ${row.number}`).toEqual(expected);
    }
  });

  it("reads each row from the current head's checks", async () => {
    const page = await scoped(() => readWorkItemRows(scope, 500));
    const rowOf = (sent: Sent) => page.items.find((row) => row.id === sent.publicId);
    expect(rowOf(items.threeHeads)).toMatchObject({ state: "review", wait: { kind: "ready_for_review", head: SHA3 }, send: { checks: "passing" } });
    expect(rowOf(items.failingNow)).toMatchObject({
      state: "review",
      wait: { kind: "check_failed", check: "test", conclusion: "failure", head: SHA2 },
      send: { checks: "failing" },
    });
    expect(rowOf(items.returned)).toMatchObject({
      state: "ready",
      wait: { kind: "ready", last_send: { delivery: "returned", reason: "The test fails." } },
      send: { delivery: "returned", checks: "failing" },
    });
    expect(rowOf(items.resent)).toMatchObject({ state: "sent", send: { send: 2, checks: "no_pull_request" } });
    expect(rowOf(items.done)).toMatchObject({ state: "done", send: { checks: "passing", accepted: true } });
    expect(rowOf(items.running)).toMatchObject({ state: "running", send: { checks: "no_pull_request" } });
  });

  it("reduces each item to the projection of every fact, and leaves out the checks on older heads", async () => {
    const ids = Object.values(items).map((sent) => sent.itemId);
    await inScope(async (tx) => {
      const listed = await listFactsByItem(tx, scope, ids);
      for (const sent of Object.values(items)) {
        const record = await readWorkItem(tx, scope, sent.itemId);
        expect(listed.get(sent.itemId)?.projection, sent.publicId).toEqual(record.projection);
      }
      const checks = (facts: readonly { kind: string }[] | undefined) => (facts ?? []).filter((fact) => fact.kind === "check_observed").length;
      const all = await readWorkItem(tx, scope, items.threeHeads.itemId);
      // Three heads hold eight checks, and only the current head's four count.
      expect(checks(all.facts)).toBe(8);
      expect(checks(listed.get(items.threeHeads.itemId)?.facts)).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // 500 items of 50 facts each
  // -------------------------------------------------------------------------

  describe("at 500 items of 50 facts each", () => {
    const CHECKS = ["a", "b", "c", "d"];
    let bulkIds: string[] = [];

    /**
     * 46 facts on top of the 4 the store writes (collected, brief saved,
     * approved, send requested): the claim, the run, the pull request, four
     * heads with four required checks each seen pending and then finished,
     * a re-run of check `a` on the current head, and the run's end. Check `b`
     * failed on every older head. Every check passed on the current one.
     */
    function bulkFacts(sent: Sent, target: Agent, runId: string): Fact[] {
      const observations = (failB: boolean): [string, CheckConclusion][] => [
        ...CHECKS.map((name): [string, CheckConclusion] => [name, "pending"]),
        ...CHECKS.map((name): [string, CheckConclusion] => [name, failB && name === "b" ? "failure" : "success"]),
      ];
      return [
        ...started(sent, target, runId),
        ...headFacts(sent.orderId, SHA1, CHECKS, observations(true)),
        ...headFacts(sent.orderId, SHA2, CHECKS, observations(true)),
        ...headFacts(sent.orderId, SHA3, CHECKS, observations(true)),
        ...headFacts(sent.orderId, SHA4, CHECKS, [...observations(false), ["a", "pending"], ["a", "success"]]),
        runtimeFact(sent.orderId, target.hostPublicId, "run_ended", runId),
      ];
    }

    beforeAll(async () => {
      const inBulk = inScopeOf(bulk);
      const lanes = await Promise.all(Array.from({ length: BULK_LANES }, (_, lane) => agent(bulk, `Bulk ${lane}`)));
      const perLane = BULK_ITEMS / BULK_LANES;
      const written = await Promise.all(
        lanes.map(async (target, lane) => {
          const ids: string[] = [];
          // One send at a time per agent: the run's end frees it for the next.
          for (let i = 0; i < perLane; i += 1) {
            const runId = `tse_${tag}x${lane}y${i}`;
            ids.push(
              await inBulk(async (tx) => {
                const sent = await sendNewItem(tx, bulk, target);
                await append(tx, bulk, sent, bulkFacts(sent, target, runId));
                return sent.itemId;
              }),
            );
          }
          return ids;
        }),
      );
      bulkIds = written.flat();
    }, 300_000);

    it("holds 50 facts an item, and the list reads at most 26 of them", async () => {
      const [stored] = await withSystemDb((tx) =>
        tx
          .select({ n: count() })
          .from(schema.workItemFacts)
          .where(and(eq(schema.workItemFacts.orgId, bulk.orgId), eq(schema.workItemFacts.workspaceId, bulk.workspaceId))),
      );
      expect(Number(stored?.n)).toBe(BULK_ITEMS * BULK_FACTS_PER_ITEM);

      await inScopeOf(bulk)(async (tx) => {
        const listed = await listFactsByItem(tx, bulk, bulkIds);
        const read = [...listed.values()].reduce((sum, entry) => sum + entry.facts.length, 0);
        expect(listed.size).toBe(BULK_ITEMS);
        expect(read).toBeLessThanOrEqual(BULK_ITEMS * LIST_FACTS_BUDGET_PER_ITEM);
        // Every projection is still the one all 50 facts reduce to.
        for (const itemId of bulkIds) {
          const record = await readWorkItem(tx, bulk, itemId);
          expect(record.facts).toHaveLength(BULK_FACTS_PER_ITEM);
          expect(listed.get(itemId)?.projection).toEqual(record.projection);
        }
      });
    });

    it("answers all 500 rows from the current head's passing checks", async () => {
      const page = await scopedOf(bulk)(() => readWorkItemRows(bulk, BULK_ITEMS));
      expect(page.items).toHaveLength(BULK_ITEMS);
      expect(page.truncated).toBe(false);
      for (const row of page.items) {
        expect(row).toMatchObject({ state: "review", wait: { kind: "ready_for_review", head: SHA4 }, send: { checks: "passing" } });
      }
    });
  });
});
