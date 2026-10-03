// The read side of the forge store (ADR-292): which pull requests a run, a
// work order, a work item, or an issue produced, each with its latest
// revision, and their change rolled up by repository.
//
// Every link resolves in Postgres. A scope is first turned into pull request
// ids through the forge link tables. Two older stores still name links the
// forge store may not hold yet, so they are read too and matched to forge
// rows by provider, repository, and number:
//
//   - `tacho.run_pull_requests`, the per-run rows ADR-192 created before the
//     forge store existed;
//   - `work.item_facts` `pr_linked` facts, which name a work order's pull
//     request by repository and number.
//
// A link either store names that the forge store has no row for yet reads as
// nothing here: the forge row comes with the pull request's next delivery or
// the backfill. Each query reads one schema, and the results are joined in
// code, so no query crosses a schema boundary.
import { schema, type Tx } from "@oxagen/database";
import type {
  ChangeSetGetOutput,
  ChangeSetPullRequest,
  ChangeSetScope,
} from "@oxagen/oxagen/contracts/forge.changes.get";
import {
  CHANGE_SET_MAX_FILES_PER_PULL_REQUEST,
  CHANGE_SET_MAX_FILES_PER_REPOSITORY,
  CHANGE_SET_MAX_PULL_REQUESTS,
} from "@oxagen/oxagen/contracts/forge.changes.get";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Scope } from "./store";

const pulls = schema.forgePullRequests;
const revisions = schema.forgePullRequestRevisions;
const runLinks = schema.forgePullRequestRuns;
const orderLinks = schema.forgePullRequestWorkOrders;
const issueLinks = schema.forgePullRequestIssues;

type Db = Pick<Tx, "select" | "selectDistinct">;

/** A pull request named by provider, repository, and number. */
export type PullKey = { provider: string; repository: string; number: number };

const ISSUE_NODE = /^issue:node:(.+)$/;

function keyString(key: PullKey): string {
  return `${key.provider}:${key.repository.toLowerCase()}#${key.number}`;
}

/** The forge ids of the pull requests the given keys name. */
export async function idsForKeys(
  db: Db,
  scope: Scope,
  keys: readonly PullKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map(keyString));
  const rows = await db
    .select({
      id: pulls.id,
      provider: pulls.provider,
      repository: pulls.repository,
      number: pulls.number,
    })
    .from(pulls)
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        inArray(pulls.number, [...new Set(keys.map((key) => key.number))]),
      ),
    );
  return rows.filter((row) => wanted.has(keyString(row))).map((row) => row.id);
}

/** The forge ids of a run's pull requests: its forge links, then its tacho rows. */
export async function runPullRequestIds(
  db: Db,
  scope: Scope,
  runId: string,
): Promise<string[]> {
  const linked = await db
    .select({ id: runLinks.pullRequestId })
    .from(runLinks)
    .where(
      and(
        eq(runLinks.orgId, scope.orgId),
        eq(runLinks.workspaceId, scope.workspaceId),
        eq(runLinks.runId, runId),
      ),
    );
  const ids = linked.map((row) => row.id);
  if (!runId.startsWith("tse_")) return ids;
  const sessions = schema.tachoSessions;
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.publicId, runId),
        isNull(sessions.parentSessionUuid),
      ),
    )
    .limit(1);
  if (session === undefined) return ids;
  const tacho = schema.tachoRunPullRequests;
  const rows = await db
    .select({
      provider: tacho.provider,
      repository: tacho.repository,
      number: tacho.number,
    })
    .from(tacho)
    .where(
      and(
        eq(tacho.orgId, scope.orgId),
        eq(tacho.workspaceId, scope.workspaceId),
        eq(tacho.sessionId, session.id),
      ),
    );
  return [...new Set([...ids, ...(await idsForKeys(db, scope, rows))])];
}

/** The internal id of a work order by its public id, or null. */
async function orderIdOf(
  db: Db,
  scope: Scope,
  publicId: string,
): Promise<string | null> {
  const orders = schema.workOrders;
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        eq(orders.publicId, publicId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The forge ids of the pull requests some work orders produced: their forge
 * links, then the pull requests their `pr_linked` facts name.
 */
async function orderPullRequestIds(
  db: Db,
  scope: Scope,
  orderIds: readonly string[],
): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const linked = await db
    .select({ id: orderLinks.pullRequestId })
    .from(orderLinks)
    .where(
      and(
        eq(orderLinks.orgId, scope.orgId),
        eq(orderLinks.workspaceId, scope.workspaceId),
        inArray(orderLinks.workOrderId, [...orderIds]),
      ),
    );
  const facts = schema.workItemFacts;
  const named = await db
    .selectDistinct({ repository: facts.repository, number: facts.prNumber })
    .from(facts)
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        eq(facts.kind, "pr_linked"),
        inArray(facts.orderId, [...orderIds]),
      ),
    );
  // Work orders send to GitHub today, and a fact names no provider.
  const keys = named.flatMap((row) =>
    row.repository === null || row.number === null
      ? []
      : [{ provider: "github", repository: row.repository, number: row.number }],
  );
  return [
    ...new Set([
      ...linked.map((row) => row.id),
      ...(await idsForKeys(db, scope, keys)),
    ]),
  ];
}

/** The forge ids of the pull requests that close one issue. */
async function issuePullRequestIds(
  db: Db,
  scope: Scope,
  issue: { nodeId?: string; url?: string },
): Promise<string[]> {
  const match =
    issue.nodeId !== undefined
      ? eq(issueLinks.issueNodeId, issue.nodeId)
      : issue.url !== undefined
        ? eq(issueLinks.url, issue.url)
        : undefined;
  if (match === undefined) return [];
  const rows = await db
    .select({ id: issueLinks.pullRequestId })
    .from(issueLinks)
    .where(
      and(
        eq(issueLinks.orgId, scope.orgId),
        eq(issueLinks.workspaceId, scope.workspaceId),
        match,
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * The forge ids of a work item's pull requests: every one its work orders
 * produced, and every one that closes the issue the item came from.
 */
async function itemPullRequestIds(
  db: Db,
  scope: Scope,
  item: { id: string; providerId: string | null; sourceUrl: string | null },
): Promise<string[]> {
  const orders = schema.workOrders;
  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        eq(orders.itemId, item.id),
      ),
    );
  const nodeId = item.providerId?.match(ISSUE_NODE)?.[1];
  const byIssue =
    nodeId !== undefined
      ? await issuePullRequestIds(db, scope, { nodeId })
      : item.sourceUrl !== null
        ? await issuePullRequestIds(db, scope, { url: item.sourceUrl })
        : [];
  return [
    ...new Set([
      ...(await orderPullRequestIds(
        db,
        scope,
        orderRows.map((row) => row.id),
      )),
      ...byIssue,
    ]),
  ];
}

const items = () => schema.workItems;

/** A work item by public id, or by the issue URL it came from. */
async function itemsWhere(
  db: Db,
  scope: Scope,
  where: { publicId: string } | { sourceUrl: string },
) {
  const t = items();
  return db
    .select({ id: t.id, providerId: t.providerId, sourceUrl: t.sourceUrl })
    .from(t)
    .where(
      and(
        eq(t.orgId, scope.orgId),
        eq(t.workspaceId, scope.workspaceId),
        "publicId" in where
          ? eq(t.publicId, where.publicId)
          : eq(t.sourceUrl, where.sourceUrl),
      ),
    );
}

/** What a scope resolves to: its pull request ids, or `not_found`. */
export async function scopePullRequestIds(
  db: Db,
  scope: Scope,
  kind: ChangeSetScope,
  id: string,
): Promise<string[] | "not_found"> {
  switch (kind) {
    case "run":
      return runPullRequestIds(db, scope, id);
    case "work_order": {
      const orderId = await orderIdOf(db, scope, id);
      return orderId === null
        ? "not_found"
        : orderPullRequestIds(db, scope, [orderId]);
    }
    case "work_item": {
      const [item] = await itemsWhere(db, scope, { publicId: id });
      return item === undefined
        ? "not_found"
        : itemPullRequestIds(db, scope, item);
    }
    case "issue": {
      // An issue has no row of its own. Its pull requests are the ones that
      // name it, and those of every work item that came from it.
      const direct = await issuePullRequestIds(db, scope, { url: id });
      const fromItems = await itemsWhere(db, scope, { sourceUrl: id });
      const viaItems = (
        await Promise.all(
          fromItems.map((item) => itemPullRequestIds(db, scope, item)),
        )
      ).flat();
      return [...new Set([...direct, ...viaItems])];
    }
  }
}

type PullRow = typeof pulls.$inferSelect;
type RevisionRow = typeof revisions.$inferSelect;

function wireState(row: Pick<PullRow, "state" | "draft">): ChangeSetPullRequest["state"] {
  if (row.state === "merged") return "merged";
  if (row.state === "closed") return "closed";
  return row.draft ? "draft" : "open";
}

/**
 * The pull requests and the revision of each one's latest head, or its newest
 * revision while the latest head's is not captured yet. Newest first.
 */
export async function readPullRequests(
  db: Db,
  scope: Scope,
  ids: readonly string[],
): Promise<{ pull: PullRow; revision: RevisionRow | null }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(pulls)
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        inArray(pulls.id, [...ids]),
      ),
    )
    .orderBy(desc(pulls.stateSeenAt));
  const revs = await db
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.orgId, scope.orgId),
        eq(revisions.workspaceId, scope.workspaceId),
        inArray(
          revisions.pullRequestId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(desc(revisions.capturedAt));
  return rows.map((pull) => {
    const own = revs.filter((rev) => rev.pullRequestId === pull.id);
    const revision =
      own.find((rev) => rev.headSha === pull.headSha) ?? own[0] ?? null;
    return { pull, revision };
  });
}

/** One pull request's entry in a change set. */
export function pullRequestEntry(
  pull: PullRow,
  revision: RevisionRow | null,
): ChangeSetPullRequest {
  const files = revision?.files ?? [];
  return {
    id: String(pull.publicId),
    provider: pull.provider as ChangeSetPullRequest["provider"],
    repository: pull.repository,
    number: pull.number,
    url: pull.url,
    title: pull.title,
    state: wireState(pull),
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    mergedAt: pull.mergedAt?.toISOString() ?? null,
    closedAt: pull.closedAt?.toISOString() ?? null,
    stateSeenAt: pull.stateSeenAt.toISOString(),
    revision:
      revision === null
        ? null
        : {
            id: String(revision.publicId),
            headSha: revision.headSha,
            mergeBaseSha: revision.mergeBaseSha,
            diffStatus:
              revision.diffStatus as NonNullable<
                ChangeSetPullRequest["revision"]
              >["diffStatus"],
            complete: revision.complete,
            limitations: revision.limitations,
            filesChanged: revision.filesChanged,
            additions: revision.additions,
            deletions: revision.deletions,
            diffBytes: revision.diffBytes,
            capturedAt: revision.capturedAt.toISOString(),
          },
    files: files.slice(0, CHANGE_SET_MAX_FILES_PER_PULL_REQUEST).map((file) => ({
      path: file.path,
      ...(file.previousPath === undefined
        ? {}
        : { previousPath: file.previousPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    moreFiles: files.length > CHANGE_SET_MAX_FILES_PER_PULL_REQUEST,
  };
}

/** One path's totals across the pull requests in a repository's roll-up. */
type FileTotals = {
  pullRequestIds: string[];
  additions: number | null;
  deletions: number | null;
};

/** One repository's running totals while the roll-up is built. */
type RepoTotals = {
  provider: ChangeSetPullRequest["provider"];
  repository: string;
  pullRequests: number;
  additions: number | null;
  deletions: number | null;
  files: Map<string, FileTotals>;
  moreFiles: boolean;
};

function add(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/**
 * The change rolled up by repository. Each pull request in the roll-up adds
 * its own files and counts; a pull request closed without merging changed
 * nothing and is left out. A path two pull requests touched is one entry that
 * names both and sums their counts. Repositories sort by name.
 */
export function rollUp(
  entries: readonly ChangeSetPullRequest[],
): ChangeSetGetOutput["repositories"] {
  const repos = new Map<string, RepoTotals>();
  for (const entry of entries) {
    if (entry.state === "closed") continue;
    const key = `${entry.provider}:${entry.repository}`;
    const repo: RepoTotals = repos.get(key) ?? {
      provider: entry.provider,
      repository: entry.repository,
      pullRequests: 0,
      additions: 0,
      deletions: 0,
      files: new Map<string, FileTotals>(),
      moreFiles: false,
    };
    repo.pullRequests += 1;
    repo.additions = add(repo.additions, entry.revision?.additions ?? null);
    repo.deletions = add(repo.deletions, entry.revision?.deletions ?? null);
    repo.moreFiles ||= entry.moreFiles;
    for (const file of entry.files) {
      const held: FileTotals | undefined = repo.files.get(file.path);
      repo.files.set(
        file.path,
        held === undefined
          ? {
              pullRequestIds: [entry.id],
              additions: file.additions,
              deletions: file.deletions,
            }
          : {
              pullRequestIds: [...held.pullRequestIds, entry.id],
              additions: add(held.additions, file.additions),
              deletions: add(held.deletions, file.deletions),
            },
      );
    }
    repos.set(key, repo);
  }
  return [...repos.values()]
    .sort((a, b) => a.repository.localeCompare(b.repository))
    .map((repo) => {
      const files = [...repo.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => ({ path, ...file }));
      return {
        provider: repo.provider,
        repository: repo.repository,
        pullRequests: repo.pullRequests,
        filesChanged: files.length,
        additions: repo.additions,
        deletions: repo.deletions,
        files: files.slice(0, CHANGE_SET_MAX_FILES_PER_REPOSITORY),
        moreFiles:
          repo.moreFiles || files.length > CHANGE_SET_MAX_FILES_PER_REPOSITORY,
      };
    });
}

/** A scope's change set: its pull requests, newest first, and the roll-up. */
export async function readChangeSet(
  db: Db,
  scope: Scope,
  kind: ChangeSetScope,
  id: string,
): Promise<ChangeSetGetOutput | "not_found"> {
  const ids = await scopePullRequestIds(db, scope, kind, id);
  if (ids === "not_found") return ids;
  const read = await readPullRequests(db, scope, ids);
  const entries = read
    .slice(0, CHANGE_SET_MAX_PULL_REQUESTS)
    .map(({ pull, revision }) => pullRequestEntry(pull, revision));
  return {
    scope: kind,
    id,
    pullRequests: entries,
    morePullRequests: read.length > CHANGE_SET_MAX_PULL_REQUESTS,
    repositories: rollUp(entries),
  };
}

/** One revision by its public id, with its pull request's public id. */
export async function readRevision(
  db: Db,
  scope: Scope,
  publicId: string,
): Promise<{ revision: RevisionRow; pullRequestPublicId: string } | null> {
  const [revision] = await db
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.orgId, scope.orgId),
        eq(revisions.workspaceId, scope.workspaceId),
        eq(revisions.publicId, publicId),
      ),
    )
    .limit(1);
  if (revision === undefined) return null;
  const [pull] = await db
    .select({ publicId: pulls.publicId })
    .from(pulls)
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        eq(pulls.id, revision.pullRequestId),
      ),
    )
    .limit(1);
  return pull === undefined
    ? null
    : { revision, pullRequestPublicId: String(pull.publicId) };
}
