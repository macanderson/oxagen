// The forge rows behind a run's pull requests, for `get_run_work` (ADR-292).
//
// The run's own change set is the base: its `forge.pull_request_runs` links,
// and the `tacho.run_pull_requests` rows matched to forge rows. Three older
// sources still name pull requests the forge store may already hold without
// a run link, so each is looked up in it too:
//
//   - a ledger run's `provider_publish` receipts, by GitHub repository id and
//     number;
//   - a wrapped run's `oxagen:pr_link` frames, by repository path and number;
//   - a checkout's branch, matched to a pull request's head branch in the same
//     repository.
//
// None of them asks a forge. A pull request the forge store does not hold
// reads as nothing here and is counted, so the caller can say so. Each query
// reads one schema, and the joins happen in code.
import { schema, type Tx } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import {
  idsForKeys,
  type PullKey,
  readPullRequests,
  runPullRequestIds,
} from "./read";
import type { Scope } from "./store";

const pulls = schema.forgePullRequests;
const issueLinks = schema.forgePullRequestIssues;

type Db = Pick<Tx, "select" | "selectDistinct">;
type PullRow = typeof pulls.$inferSelect;
type RevisionRow = typeof schema.forgePullRequestRevisions.$inferSelect;
type IssueRow = typeof issueLinks.$inferSelect;

/** The most pull requests one branch match reads. */
const BRANCH_MATCH_ROWS = 200;

/** How a run's pull request reached the read. */
export type RunPullSource = "run" | "recorded" | "branch";

/** A checkout's branch in one repository. */
export type BranchKey = {
  provider: PullKey["provider"];
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: string;
  branch: string;
};

export type RunPullRequestQuery = {
  /** The run's public id (`tse_` or `arun_`). */
  runId: string;
  /** Ledger receipts: a GitHub repository id and a number. */
  receipts: readonly { providerRepositoryId: string; number: number }[];
  /** Pull requests the run's frames name by repository path and number. */
  links: readonly PullKey[];
  /** The branches the run's checkouts were on. */
  branches: readonly BranchKey[];
};

export type RunPullRequest = {
  pull: PullRow;
  revision: RevisionRow | null;
  sources: RunPullSource[];
  /** The issues the pull request's closing references name. */
  issues: IssueRow[];
};

export type RunPullRequestRead = {
  /** Newest first, by when the forge last reported each one. */
  pullRequests: RunPullRequest[];
  /** Receipts and links that name a pull request the forge store lacks. */
  unstored: number;
  /**
   * The branches other pull requests merge into, as `branchKeyOf` writes
   * them. A checkout on one of them names no work of its own.
   */
  trunks: string[];
};

/** One branch in one repository, as a string. */
export function branchKeyOf(key: BranchKey): string {
  return `${key.provider}:${key.repository.toLowerCase()}:${key.branch}`;
}

/** The forge ids of the GitHub pull requests ledger receipts name. */
async function idsForReceipts(
  db: Db,
  scope: Scope,
  receipts: RunPullRequestQuery["receipts"],
): Promise<{ ids: string[]; unstored: number }> {
  if (receipts.length === 0) return { ids: [], unstored: 0 };
  const keyOf = (id: string, number: number) => `${id}#${number}`;
  const wanted = new Set(
    receipts.map((receipt) =>
      keyOf(receipt.providerRepositoryId, receipt.number),
    ),
  );
  const rows = await db
    .select({
      id: pulls.id,
      providerRepositoryId: pulls.providerRepositoryId,
      number: pulls.number,
    })
    .from(pulls)
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        eq(pulls.provider, "github"),
        inArray(pulls.number, [...new Set(receipts.map((r) => r.number))]),
      ),
    );
  const found = rows.filter((row) =>
    wanted.has(keyOf(row.providerRepositoryId, row.number)),
  );
  return {
    ids: found.map((row) => row.id),
    unstored:
      wanted.size -
      new Set(found.map((row) => keyOf(row.providerRepositoryId, row.number)))
        .size,
  };
}

/**
 * The forge ids of the pull requests whose head branch a checkout was on,
 * and the branches that are another pull request's base. A pull request's
 * base is a branch others merge into, such as `main`. Every pull request
 * opened from a fork's `main` has `main` as its head, so a checkout on a
 * trunk would match work that is not the run's. Such a branch matches
 * nothing; a stacked base still reaches the read through the run's own link.
 */
async function idsForBranches(
  db: Db,
  scope: Scope,
  branches: readonly BranchKey[],
): Promise<{ ids: string[]; trunks: string[] }> {
  if (branches.length === 0) return { ids: [], trunks: [] };
  const wanted = new Set(branches.map(branchKeyOf));
  const names = [...new Set(branches.map((key) => key.branch))];
  const fence = and(
    eq(pulls.orgId, scope.orgId),
    eq(pulls.workspaceId, scope.workspaceId),
    inArray(pulls.repository, [
      ...new Set(branches.map((key) => key.repository.toLowerCase())),
    ]),
  );
  // Two reads, so the many pull requests that merge into a trunk never fill
  // the cap the head branch matches are read under.
  const heads = await db
    .select({
      id: pulls.id,
      provider: pulls.provider,
      repository: pulls.repository,
      branch: pulls.headRef,
    })
    .from(pulls)
    .where(and(fence, inArray(pulls.headRef, names)))
    .limit(BRANCH_MATCH_ROWS);
  const bases = await db
    .selectDistinct({
      provider: pulls.provider,
      repository: pulls.repository,
      branch: pulls.baseRef,
    })
    .from(pulls)
    .where(and(fence, inArray(pulls.baseRef, names)));
  const keyOf = (row: {
    provider: string;
    repository: string;
    branch: string | null;
  }) =>
    row.branch === null
      ? null
      : branchKeyOf({
          provider: row.provider as BranchKey["provider"],
          repository: row.repository,
          branch: row.branch,
        });
  const trunks = new Set(
    bases.flatMap((row) => {
      const key = keyOf(row);
      return key !== null && wanted.has(key) ? [key] : [];
    }),
  );
  const ids = heads.flatMap((row) => {
    const key = keyOf(row);
    return key !== null && wanted.has(key) && !trunks.has(key) ? [row.id] : [];
  });
  return { ids, trunks: [...trunks] };
}

/** The issue links of some pull requests, by pull request id. */
async function issuesOf(
  db: Db,
  scope: Scope,
  ids: readonly string[],
): Promise<Map<string, IssueRow[]>> {
  const out = new Map<string, IssueRow[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(issueLinks)
    .where(
      and(
        eq(issueLinks.orgId, scope.orgId),
        eq(issueLinks.workspaceId, scope.workspaceId),
        inArray(issueLinks.pullRequestId, [...ids]),
      ),
    );
  for (const row of rows) {
    const held = out.get(row.pullRequestId);
    if (held === undefined) out.set(row.pullRequestId, [row]);
    else held.push(row);
  }
  return out;
}

/** A run's pull requests from the forge store, each with how it was reached. */
export async function readRunPullRequests(
  db: Db,
  scope: Scope,
  query: RunPullRequestQuery,
): Promise<RunPullRequestRead> {
  const linked = await runPullRequestIds(db, scope, query.runId);
  const receipts = await idsForReceipts(db, scope, query.receipts);
  const named = await idsForKeys(db, scope, query.links);
  const branches = await idsForBranches(db, scope, query.branches);
  const sources = new Map<string, Set<RunPullSource>>();
  const mark = (ids: readonly string[], source: RunPullSource) => {
    for (const id of ids) {
      const held = sources.get(id);
      if (held === undefined) sources.set(id, new Set([source]));
      else held.add(source);
    }
  };
  mark(linked, "run");
  mark([...receipts.ids, ...named], "recorded");
  mark(branches.ids, "branch");
  const read = await readPullRequests(db, scope, [...sources.keys()]);
  const issues = await issuesOf(
    db,
    scope,
    read.map(({ pull }) => pull.id),
  );
  const linkKeys = new Set(
    query.links.map(
      (key) => `${key.provider}:${key.repository.toLowerCase()}#${key.number}`,
    ),
  );
  return {
    pullRequests: read.map(({ pull, revision }) => ({
      pull,
      revision,
      sources: [...(sources.get(pull.id) ?? [])],
      issues: issues.get(pull.id) ?? [],
    })),
    unstored: receipts.unstored + Math.max(0, linkKeys.size - named.length),
    trunks: branches.trunks,
  };
}

/** One pull request's issue links, as `readClosingIssueLinks` answers them. */
export type StoredClosingIssues = {
  key: PullKey;
  /** False when the forge store holds no row for the pull request. */
  stored: boolean;
  /**
   * False when the pull request has no revision yet. The sync reads its
   * closing references with each new head, so none were read.
   */
  read: boolean;
  issues: IssueRow[];
};

/**
 * The issue links of pull requests named by provider, repository, and number,
 * in the order the keys came, and whether the store holds each one.
 */
export async function readClosingIssueLinks(
  db: Db,
  scope: Scope,
  keys: readonly PullKey[],
): Promise<StoredClosingIssues[]> {
  if (keys.length === 0) return [];
  const keyOf = (key: PullKey) =>
    `${key.provider}:${key.repository.toLowerCase()}#${key.number}`;
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
  const byKey = new Map(
    rows.map((row) => [
      keyOf({
        provider: row.provider as PullKey["provider"],
        repository: row.repository,
        number: row.number,
      }),
      row.id,
    ]),
  );
  const ids = [...new Set(byKey.values())];
  const revisions = schema.forgePullRequestRevisions;
  const captured =
    ids.length === 0
      ? []
      : await db
          .selectDistinct({ id: revisions.pullRequestId })
          .from(revisions)
          .where(
            and(
              eq(revisions.orgId, scope.orgId),
              eq(revisions.workspaceId, scope.workspaceId),
              inArray(revisions.pullRequestId, ids),
            ),
          );
  const read = new Set(captured.map((row) => row.id));
  const issues = await issuesOf(db, scope, ids);
  return keys.map((key) => {
    const id = byKey.get(keyOf(key));
    return id === undefined
      ? { key, stored: false, read: false, issues: [] }
      : { key, stored: true, read: read.has(id), issues: issues.get(id) ?? [] };
  });
}
