// results.ts: a send's results, recorded as they arrive (P1-04, ADR-251).
//
// Three arrivals reach a send after its run is linked:
//
//   - The run seals (`cost/run.sealed`): the send records `run_ended`, and the
//     pull requests the run linked are recorded too, in case their link
//     arrived before the run did.
//   - The run names a pull request (`run/pull-request.linked`): when the pull
//     request is in the send's repository, the send records `pr_linked`, and
//     Oxagen reads its head, required checks, and check results from GitHub
//     (evidence.ts).
//   - GitHub delivers a `pull_request` event: every send that linked the pull
//     request records the new head, a human merge, or a close without merging.
//
// Each runs in the send's own tenant scope. Facts carry dedupe keys, so a
// redelivered event or a retried function records nothing twice. GitHub's
// webhook carries no delivery id here, and the keys are what stop a repeat.
//
// A delivery of a merged pull request whose body names a send's merged pull
// request as `Reverts <owner>/<repo>#<n>`, the line GitHub's Revert button
// writes, records `reverted` on that send. The item stays done: a person
// reopens it, and the revert only feeds the Outcomes count (ADR-286, amended
// 2026-10-03). A revert made without that line records nothing.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { type FactInput, type FactKind, HEAD_SHA_PATTERN, WorkRecordError } from "@oxagen/work/records";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { type EvidenceReader, type PullRequestRead, evidenceFacts, githubEvidenceReader, ordersForPullRequest, readEvidence } from "./evidence";
import { endWorkOrderRuns } from "./runtime";
import { appendFacts, readWorkItem, type WorkScope } from "./store";

/** A GitHub pull request URL's repository (lower case) and number, or null. Pure. */
export function parsePullRequestUrl(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})(?:[/?#].*)?$/.exec(url);
  if (match === null) return null;
  return { repository: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) };
}

/** A send linked to a run, with the repository its brief changes. */
interface LinkedSend {
  orderId: string;
  itemId: string;
  repository: string;
}

async function sendsLinkedTo(tx: Tx, scope: WorkScope, runId: string): Promise<LinkedSend[]> {
  const facts = schema.workItemFacts;
  const orders = schema.workOrders;
  return tx
    .selectDistinct({ orderId: orders.id, itemId: orders.itemId, repository: orders.repository })
    .from(facts)
    .innerJoin(orders, eq(orders.id, facts.orderId))
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        eq(facts.kind, "run_linked"),
        eq(facts.runId, runId),
      ),
    );
}

async function rootRunOf(tx: Tx, scope: WorkScope, rootSessionUuid: string): Promise<string | null> {
  const sessions = schema.tachoSessions;
  const [row] = await tx
    .select({ publicId: sessions.publicId })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.sessionUuid, rootSessionUuid),
        isNull(sessions.parentSessionUuid),
      ),
    )
    .limit(1);
  return row ? String(row.publicId) : null;
}

/** Read GitHub for one send and record what it found. Never fails the caller's write. */
async function recordSendEvidence(scope: WorkScope, itemId: string, orderId: string, reader: EvidenceReader, now: Date): Promise<number> {
  const order = await withTenantDb(async (tx) => {
    const record = await readWorkItem(tx, scope, itemId);
    return record.projection.orders.find((entry) => entry.orderId === orderId) ?? null;
  });
  if (order === null || order.closed) return 0;
  const read = await readEvidence(reader, scope, order);
  const { facts } = evidenceFacts(order, read, now.toISOString());
  if (facts.length === 0) return 0;
  const write = await withTenantDb((tx) => appendFacts(tx, scope, { itemId, facts }));
  return write.repeat ? 0 : facts.length;
}

/** The seams the result recorders take. Tests pass fakes. */
export interface ResultDeps {
  reader: EvidenceReader;
  now(): Date;
}

const DEFAULT_DEPS: ResultDeps = { reader: githubEvidenceReader, now: () => new Date() };

/**
 * Record that a run linked to a send ended, with the run's outcome. Returns
 * the number of sends that recorded it.
 */
export async function recordRunEnded(scope: WorkScope, runId: string, deps: ResultDeps = DEFAULT_DEPS): Promise<number> {
  const ended = await runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      const sessions = schema.tachoSessions;
      const [session] = await tx
        .select({ id: sessions.id, outcome: sessions.outcome, sessionUuid: sessions.sessionUuid })
        .from(sessions)
        .where(and(eq(sessions.orgId, scope.orgId), eq(sessions.workspaceId, scope.workspaceId), eq(sessions.publicId, runId)))
        .limit(1);
      const recorded = await endWorkOrderRuns(tx, scope, runId, session?.outcome ?? null, deps.now());
      if (recorded === 0 || session === undefined) return { recorded, session: null, urls: [] as string[] };
      // A pull request the run named before its link landed found no send
      // then. Its row is on the run, so it is recorded on the send now.
      const prs = schema.tachoRunPullRequests;
      const rows = await tx
        .select({ url: prs.url })
        .from(prs)
        .where(and(eq(prs.orgId, scope.orgId), eq(prs.workspaceId, scope.workspaceId), eq(prs.sessionId, session.id)));
      return { recorded, session, urls: rows.map((row) => row.url) };
    }),
  );
  for (const url of ended.urls) {
    if (ended.session !== null) await recordRunPullRequest(scope, ended.session.sessionUuid, url, deps);
  }
  return ended.recorded;
}

/**
 * Record a pull request a run named, on every send linked to the run whose
 * brief changes the pull request's repository, then read its evidence. A pull
 * request in another repository is not the send's result and is left out.
 * Returns the number of facts recorded.
 */
export async function recordRunPullRequest(
  scope: WorkScope,
  rootSessionUuid: string,
  url: string,
  deps: ResultDeps = DEFAULT_DEPS,
): Promise<number> {
  const pr = parsePullRequestUrl(url);
  if (pr === null) return 0;
  return runInTenantScope(scope, async () => {
    const linked = await withTenantDb(async (tx) => {
      const runId = await rootRunOf(tx, scope, rootSessionUuid);
      if (runId === null) return [];
      const sends = await sendsLinkedTo(tx, scope, runId);
      const recorded: LinkedSend[] = [];
      for (const send of sends) {
        if (send.repository.toLowerCase() !== pr.repository) continue;
        const fact: FactInput<FactKind> = {
          kind: "pr_linked",
          source: "runtime",
          itemRevision: 1,
          orderId: send.orderId,
          repository: pr.repository,
          prNumber: pr.number,
          runId,
          actor: runId,
          occurredAt: deps.now().toISOString(),
          dedupeKey: `pr_linked:${send.orderId}:${pr.repository}#${pr.number}`,
          data: {},
        };
        try {
          await tx.transaction((savepoint) => appendFacts(savepoint as Tx, scope, { itemId: send.itemId, facts: [fact] }));
          recorded.push(send);
        } catch (error) {
          // A send that ended refuses nothing here, but a missing one would;
          // the link stays on the run either way.
          if (!(error instanceof WorkRecordError)) throw error;
        }
      }
      return recorded;
    });
    let facts = linked.length;
    for (const send of linked) facts += await recordSendEvidence(scope, send.itemId, send.orderId, deps.reader, deps.now());
    return facts;
  });
}

/** What a `pull_request` delivery says about one pull request. */
export interface PullRequestDelivery {
  repository: string;
  number: number;
  /**
   * The pull requests in the same repository the body says this one reverts,
   * by number (revertedPullRequestsOf). They count only once this one merged.
   */
  reverts: number[];
  pull: PullRequestRead;
}

/** The most pull requests one body may name as reverted. Any after these are left out. */
export const MAX_REVERT_TARGETS = 20;

/**
 * The line GitHub's Revert button writes at the start of the reverting pull
 * request's body: `Reverts <owner>/<repo>#<n>`. The owner and the name follow
 * GitHub's rules, as parsePullRequestUrl's do.
 */
const REVERTS_LINE = /^[ \t]*Reverts[ \t]+([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})\b/gim;

/**
 * The pull requests a body says it reverts, by number, in the order it names
 * them and at most MAX_REVERT_TARGETS. Only a line that starts with
 * `Reverts <owner>/<repo>#<n>` counts, as GitHub's Revert button writes it. A
 * bare `#<n>`, a commit hash, and a revert made with `git revert` alone name
 * nothing here. A pull request in another repository is left out, because a
 * merge here changes nothing there, and so is the pull request's own number.
 * Pure.
 */
export function revertedPullRequestsOf(body: string | null, repository: string, number: number): number[] {
  if (body === null) return [];
  const own = repository.toLowerCase();
  const out: number[] = [];
  for (const match of body.matchAll(REVERTS_LINE)) {
    const target = Number(match[3]);
    if (`${match[1]}/${match[2]}`.toLowerCase() !== own || target === number || out.includes(target)) continue;
    out.push(target);
    if (out.length === MAX_REVERT_TARGETS) break;
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The pull request a `pull_request` delivery describes, or null when it describes none. Pure. */
export function workPullRequestDeliveryOf(body: Record<string, unknown>): PullRequestDelivery | null {
  const pr = body["pull_request"];
  const repo = body["repository"];
  if (typeof pr !== "object" || pr === null || typeof repo !== "object" || repo === null) return null;
  const p = pr as Record<string, unknown>;
  const fullName = text((repo as Record<string, unknown>)["full_name"]);
  const number = p["number"];
  if (fullName === null || typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  const head = p["head"];
  const base = p["base"];
  const headSha = typeof head === "object" && head !== null ? text((head as Record<string, unknown>)["sha"]) : null;
  const baseRef = typeof base === "object" && base !== null ? text((base as Record<string, unknown>)["ref"]) : null;
  const state = p["state"] === "closed" ? "closed" : "open";
  const updatedAt = text(p["updated_at"]) ?? new Date().toISOString();
  return {
    repository: fullName.toLowerCase(),
    number,
    reverts: revertedPullRequestsOf(text(p["body"]), fullName, number),
    pull: {
      headSha: headSha !== null && /^[0-9a-f]{40}$/.test(headSha) ? headSha : null,
      baseRef: baseRef ?? "",
      state,
      merged: p["merged"] === true,
      mergeCommitSha: text(p["merge_commit_sha"]),
      mergedAt: text(p["merged_at"]),
      updatedAt,
    },
  };
}

/**
 * Record a merged revert on every send in `scope` whose merged pull request it
 * names: one `reverted` fact per send, naming the reverting pull request and
 * its merge commit. A send counts only when the named pull request is the one
 * it follows and it merged. The fact moves no state, so a done item stays
 * done. The dedupe key names the send and the reverting pull request, so a
 * redelivery, or a later delivery about the same merged revert, records
 * nothing. Returns the facts recorded.
 */
async function recordReverts(tx: Tx, scope: WorkScope, delivery: PullRequestDelivery): Promise<number> {
  const { pull } = delivery;
  const mergeCommit = pull.merged ? pull.mergeCommitSha : null;
  if (mergeCommit === null || !HEAD_SHA_PATTERN.test(mergeCommit) || delivery.reverts.length === 0) return 0;
  let recorded = 0;
  for (const target of delivery.reverts) {
    for (const send of await ordersForPullRequest(tx, scope, delivery.repository, target)) {
      const record = await readWorkItem(tx, scope, send.itemId);
      const order = record.projection.orders.find((entry) => entry.orderId === send.orderId);
      if (order === undefined || order.merge === null) continue;
      const current = order.pullRequest;
      if (current === null || current.repository.toLowerCase() !== delivery.repository || current.number !== target) continue;
      const fact: FactInput<FactKind> = {
        kind: "reverted",
        source: "provider",
        itemRevision: 1,
        orderId: send.orderId,
        repository: delivery.repository,
        prNumber: delivery.number,
        actor: "github",
        occurredAt: pull.mergedAt ?? pull.updatedAt,
        dedupeKey: `reverted:${send.orderId}:${delivery.repository}#${delivery.number}`,
        data: { merge_commit: mergeCommit },
      };
      const write = await tx.transaction((savepoint) => appendFacts(savepoint as Tx, scope, { itemId: send.itemId, facts: [fact] }));
      if (!write.repeat) recorded += 1;
    }
  }
  return recorded;
}

/**
 * Record a `pull_request` delivery on every send in `scope` that linked the
 * pull request: its head, a merge, or a close without merging. A merged
 * revert of a send's merged pull request records `reverted` on that send
 * (recordReverts). Checks are read at Accept and by Read checks, not here.
 * Returns the facts recorded.
 */
export async function recordWorkPullRequestDelivery(scope: WorkScope, delivery: PullRequestDelivery, now: Date): Promise<number> {
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      let recorded = 0;
      for (const send of await ordersForPullRequest(tx, scope, delivery.repository, delivery.number)) {
        const record = await readWorkItem(tx, scope, send.itemId);
        const order = record.projection.orders.find((entry) => entry.orderId === send.orderId);
        if (order === undefined) continue;
        // A delivery about a pull request the send has moved past changes
        // nothing on it: the send's head, merge, and close are its current
        // pull request's.
        const current = order.pullRequest;
        if (current === null || current.repository.toLowerCase() !== delivery.repository || current.number !== delivery.number) continue;
        const { facts } = evidenceFacts(order, { pull: delivery.pull, required: null, checks: null }, now.toISOString());
        // Only the pull request's own facts: the required list and the checks
        // come from a read, never from a delivery that does not carry them.
        const own = facts.filter((fact) => fact.kind === "head_observed" || fact.kind === "merged" || fact.kind === "pr_closed");
        if (own.length === 0) continue;
        const write = await tx.transaction((savepoint) => appendFacts(savepoint as Tx, scope, { itemId: send.itemId, facts: own }));
        if (!write.repeat) recorded += own.length;
      }
      return recorded + (await recordReverts(tx, scope, delivery));
    }),
  );
}
