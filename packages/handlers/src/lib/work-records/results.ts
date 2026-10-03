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
//     request records the new head, a merge with the account that merged it
//     and whether that was the Oxagen GitHub App, or a close without merging.
//
// Each runs in the send's own tenant scope. Facts carry dedupe keys, so a
// redelivered event or a retried function records nothing twice. GitHub's
// webhook carries no delivery id here, and the keys are what stop a repeat.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { type FactInput, type FactKind, type MergedBy, WorkRecordError } from "@oxagen/work/records";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import {
  type EvidenceReader,
  type PullRequestRead,
  evidenceFacts,
  githubEvidenceReader,
  mergerOf,
  ordersForPullRequest,
  oxagenAppBotLogin,
  readEvidence,
} from "./evidence";
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
export async function recordSendEvidence(scope: WorkScope, itemId: string, orderId: string, reader: EvidenceReader, now: Date): Promise<number> {
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
  pull: PullRequestRead;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The account a delivery's `merged_by` names, with whether it is the Oxagen
 * GitHub App, or null when it names none or leaves out its login or type.
 * Pure.
 */
function mergedByOf(value: unknown, appLogin: string | null): MergedBy | null {
  if (typeof value !== "object" || value === null) return null;
  const login = text((value as Record<string, unknown>)["login"]);
  const type = text((value as Record<string, unknown>)["type"]);
  return login === null || type === null ? null : mergerOf({ login, type }, appLogin);
}

/**
 * The pull request a `pull_request` delivery describes, or null when it
 * describes none. `appLogin` is the Oxagen GitHub App's login, read from
 * GITHUB_APP_SLUG unless a test passes one. Pure apart from that default.
 */
export function workPullRequestDeliveryOf(
  body: Record<string, unknown>,
  appLogin: string | null = oxagenAppBotLogin(),
): PullRequestDelivery | null {
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
    pull: {
      headSha: headSha !== null && /^[0-9a-f]{40}$/.test(headSha) ? headSha : null,
      baseRef: baseRef ?? "",
      state,
      merged: p["merged"] === true,
      mergeCommitSha: text(p["merge_commit_sha"]),
      mergedAt: text(p["merged_at"]),
      mergedBy: mergedByOf(p["merged_by"], appLogin),
      updatedAt,
    },
  };
}

/**
 * Record a `pull_request` delivery on every send in `scope` that linked the
 * pull request: its head, a merge, or a close without merging. Checks are
 * read at Accept and by Read checks, not here. Returns the facts recorded.
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
      return recorded;
    }),
  );
}
