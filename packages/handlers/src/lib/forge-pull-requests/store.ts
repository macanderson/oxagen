// audit-exempt: forge webhooks and run links write these rows; no person authors a pull request's stored state, its revisions, or its links.
//
// The writes and reads behind the pull request sync (ADR-288). Each takes the
// transaction it runs in, so the caller chooses the tenant scope and a test
// can hand in a fake.
//
// Forges deliver out of order. A pull request row is replaced only by facts
// whose `updated_at` is at least as new as the one it holds, and an undated
// write replaces only an undated row. A revision that names stored bytes is
// never replaced: its key and digest are what a check that read it cites.
import { schema, type Tx } from "@oxagen/database";
import type {
  ForgePullRequestCapture,
  ForgePullRequestFacts,
  ForgePullRequestRecord,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ForgeProvider } from "./facts";

const pulls = schema.forgePullRequests;
const revisions = schema.forgePullRequestRevisions;
const runLinks = schema.forgePullRequestRuns;
const orderLinks = schema.forgePullRequestWorkOrders;

export type Scope = { orgId: string; workspaceId: string };

/** The most files one revision's row lists. */
export const REVISION_FILES_MAX = 3000;

function dateOf(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** The rows an upsert may replace: none holds facts newer than these. */
function newerWins(sourceUpdatedAt: Date | null): SQL | undefined {
  return sourceUpdatedAt === null
    ? isNull(pulls.sourceUpdatedAt)
    : or(
        isNull(pulls.sourceUpdatedAt),
        sql`${pulls.sourceUpdatedAt} <= ${sourceUpdatedAt}`,
      );
}

/**
 * Write a pull request's facts and answer its row's id. A first delivery
 * inserts the row. A later one replaces it unless the row holds newer facts,
 * and the row's id is answered either way.
 */
export async function upsertPullRequest(
  tx: Pick<Tx, "insert" | "select">,
  scope: Scope,
  provider: ForgeProvider,
  facts: ForgePullRequestFacts,
  seenAt: Date,
): Promise<string> {
  const sourceUpdatedAt = dateOf(facts.sourceUpdatedAt);
  const values = {
    repository: facts.repository,
    url: facts.url,
    title: facts.title,
    authorLogin: facts.authorLogin,
    state: facts.state,
    draft: facts.state === "open" && facts.draft,
    baseRef: facts.baseRef,
    headRef: facts.headRef,
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    mergeCommitSha: facts.mergeCommitSha,
    mergedAt: dateOf(facts.mergedAt),
    closedAt: dateOf(facts.closedAt),
    sourceUpdatedAt,
    stateSeenAt: seenAt,
    updatedAt: seenAt,
  };
  const written = await tx
    .insert(pulls)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      provider,
      host: facts.host,
      providerRepositoryId: facts.providerRepositoryId,
      number: facts.number,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        pulls.orgId,
        pulls.workspaceId,
        pulls.provider,
        pulls.host,
        pulls.providerRepositoryId,
        pulls.number,
      ],
      set: values,
      setWhere: newerWins(sourceUpdatedAt),
    })
    .returning({ id: pulls.id });
  const id = written[0]?.id;
  if (id !== undefined) return id;
  // The row holds newer facts, so nothing was replaced. It is still the row.
  const [held] = await tx
    .select({ id: pulls.id })
    .from(pulls)
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        eq(pulls.provider, provider),
        eq(pulls.host, facts.host),
        eq(pulls.providerRepositoryId, facts.providerRepositoryId),
        eq(pulls.number, facts.number),
      ),
    )
    .limit(1);
  if (held === undefined)
    throw new Error(
      "forge.pull-requests: the upsert wrote no row and none is held; the tenant scope may not match the row's",
    );
  return held.id;
}

/** The stored diff status of a head commit, or null when it has no revision. */
export async function revisionStatusOf(
  tx: Pick<Tx, "select">,
  pullRequestId: string,
  headSha: string,
): Promise<ForgePullRequestCapture["diffStatus"] | null> {
  const [row] = await tx
    .select({ diffStatus: revisions.diffStatus })
    .from(revisions)
    .where(
      and(
        eq(revisions.pullRequestId, pullRequestId),
        eq(revisions.headSha, headSha),
      ),
    )
    .limit(1);
  return (row?.diffStatus as ForgePullRequestCapture["diffStatus"]) ?? null;
}

/**
 * Write a head commit's revision. A row that already names stored bytes is
 * kept as it is. Any other row is replaced, so a revision first recorded
 * with no diff store, or with no hunks, is filled by a later capture.
 */
export async function recordRevision(
  tx: Pick<Tx, "insert" | "select">,
  scope: Scope,
  pullRequestId: string,
  target: { headSha: string; baseSha: string | null },
  capture: ForgePullRequestCapture,
  capturedAt: Date,
): Promise<ForgePullRequestRecord> {
  const values = {
    baseSha: target.baseSha,
    mergeBaseSha: capture.mergeBaseSha,
    diffStatus: capture.diffStatus,
    diffStore: capture.diffStore,
    diffKey: capture.diffKey,
    diffSha256: capture.diffSha256,
    diffBytes: capture.diffBytes,
    filesChanged: capture.filesChanged,
    additions: capture.additions,
    deletions: capture.deletions,
    files: capture.files.slice(0, REVISION_FILES_MAX),
    complete: capture.complete,
    limitations: capture.limitations,
    capturedAt,
  };
  await tx
    .insert(revisions)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      pullRequestId,
      headSha: target.headSha,
      ...values,
    })
    .onConflictDoUpdate({
      target: [revisions.pullRequestId, revisions.headSha],
      set: values,
      setWhere: ne(revisions.diffStatus, "stored"),
    });
  const [row] = await tx
    .select({
      id: revisions.id,
      diffStatus: revisions.diffStatus,
      diffKey: revisions.diffKey,
    })
    .from(revisions)
    .where(
      and(
        eq(revisions.pullRequestId, pullRequestId),
        eq(revisions.headSha, target.headSha),
      ),
    )
    .limit(1);
  if (row === undefined)
    throw new Error(
      "forge.pull-requests: the revision write left no row; the tenant scope may not match the row's",
    );
  return {
    revisionId: row.id,
    diffStatus: row.diffStatus as ForgePullRequestCapture["diffStatus"],
    // The row names the bytes this capture stored. A retried step answers
    // true again, and the diff-ready event's id is the revision's, so the
    // event is still sent once.
    newlyStored:
      row.diffStatus === "stored" &&
      capture.diffStatus === "stored" &&
      row.diffKey === capture.diffKey,
  };
}

/** The public id (`tse_`) of the root session a link names, or null. */
export async function runPublicIdOf(
  tx: Pick<Tx, "select">,
  scope: Scope,
  rootSessionUuid: string,
): Promise<string | null> {
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

/**
 * Link a run to a pull request. A link the run opened outranks one it only
 * recorded, so a later `opened` link upgrades the row and a later `recorded`
 * link leaves it. Answers 1 when it wrote, else 0.
 */
export async function linkRun(
  tx: Pick<Tx, "insert">,
  scope: Scope,
  pullRequestId: string,
  runId: string,
  source: "opened" | "recorded",
): Promise<number> {
  const insert = tx.insert(runLinks).values({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    pullRequestId,
    runId,
    source,
  });
  const written =
    source === "opened"
      ? await insert
          .onConflictDoUpdate({
            target: [runLinks.pullRequestId, runLinks.runId],
            set: { source: "opened" },
            setWhere: ne(runLinks.source, "opened"),
          })
          .returning({ id: runLinks.id })
      : await insert
          .onConflictDoNothing({
            target: [runLinks.pullRequestId, runLinks.runId],
          })
          .returning({ id: runLinks.id });
  return written.length;
}

/**
 * The work orders a run is linked to whose brief changes this repository:
 * the same rule a send's results use (work-records/results.ts), so a pull
 * request in another repository is not the order's.
 */
export async function workOrdersOf(
  tx: Pick<Tx, "selectDistinct">,
  scope: Scope,
  runId: string,
  repository: string,
): Promise<string[]> {
  const facts = schema.workItemFacts;
  const orders = schema.workOrders;
  const rows = await tx
    .selectDistinct({ orderId: orders.id })
    .from(facts)
    .innerJoin(orders, eq(orders.id, facts.orderId))
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        eq(facts.kind, "run_linked"),
        eq(facts.runId, runId),
        sql`lower(${orders.repository}) = ${repository.toLowerCase()}`,
      ),
    );
  return rows.map((row) => row.orderId);
}

/** Link work orders to a pull request. Answers how many links were new. */
export async function linkWorkOrders(
  tx: Pick<Tx, "insert">,
  scope: Scope,
  pullRequestId: string,
  orderIds: readonly string[],
  runId: string,
): Promise<number> {
  if (orderIds.length === 0) return 0;
  const written = await tx
    .insert(orderLinks)
    .values(
      orderIds.map((workOrderId) => ({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pullRequestId,
        workOrderId,
        runId,
      })),
    )
    .onConflictDoNothing({
      target: [orderLinks.pullRequestId, orderLinks.workOrderId],
    })
    .returning({ id: orderLinks.id });
  return written.length;
}
