// What `list_runs` shows beside each wrapped session's row: the pull requests
// its frames name, and the lines it added and removed. Both are read for a
// whole page at once, one query per store, so a page of a hundred runs costs
// two reads and not two hundred.
//
//   Pull requests  ClickHouse `tacho_events`: the `oxagen:pr_link` frames the
//                  harness wrote (attrs `pr_url`, `pr_number`,
//                  `pr_repository`) and the `pr_open` effect frames whose
//                  call printed a URL (attrs `pr.url`, `pr.number`,
//                  `pr.repository`). One row per session and URL, earliest
//                  frame first. Only chain-verified frames count.
//   Lines          `tacho.sessions.lines_added/removed`, the harness's own
//                  totals from the session's end, and while those are absent
//                  the uncommitted change git reported per path
//                  (`tacho.session_files`, root and subagent chains).
//
// No store records a pull request's state (open, merged, closed, draft), so
// every pull request here carries `state: null`. `get_run_work` reads the
// live state from GitHub for one run; a list of a hundred runs does not.
import { schema, withTenantDb } from "@oxagen/database";
import type {
  RunDiff,
  RunPullRequest,
  RunPullRequestFilter,
} from "@oxagen/oxagen/contracts/run.list";
import { RUN_PULL_REQUEST_MAX } from "@oxagen/oxagen/contracts/run.list";
import { chSelect } from "@oxagen/telemetry";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { RunScope } from "../run.list";

/** One session's pull request as the ClickHouse read returns it. */
export type PullRequestLinkRow = {
  session: string;
  url: string;
  number: string;
  repository: string;
  first_seq: string;
};

/** The pull requests each session's frames name, by session uuid. */
export type ReadRunPullRequests = (
  sessionUuids: readonly string[],
) => Promise<Map<string, RunPullRequest[]>>;

/** Git's uncommitted change per root session uuid, where git reported any. */
export type ReadRunGitDiffs = (
  scope: RunScope,
  sessionUuids: readonly string[],
) => Promise<Map<string, { added: number; removed: number }>>;

/**
 * A recorded pull request, or null when the row names no https page. The
 * number and repository are kept only when they are well formed: a frame
 * that recorded `#0` or a blank repository says nothing about either.
 */
export function pullRequestOf(row: PullRequestLinkRow): RunPullRequest | null {
  if (!URL.canParse(row.url)) return null;
  if (new URL(row.url).protocol !== "https:") return null;
  const number = Number(row.number);
  return {
    url: row.url,
    number: Number.isSafeInteger(number) && number > 0 ? number : null,
    repository: row.repository === "" ? null : row.repository,
    state: null,
  };
}

/**
 * The ClickHouse read. `chSelect` fences it to the caller's org and workspace
 * before any predicate here, and admits a single-table SELECT only, so the two
 * frame shapes are folded with `if()` rather than a UNION. `LIMIT n BY`
 * keeps one session's links from crowding the others out of the page.
 */
export const readRunPullRequests: ReadRunPullRequests = async (
  sessionUuids,
) => {
  const out = new Map<string, RunPullRequest[]>();
  if (sessionUuids.length === 0) return out;
  const linked = "kind = 'oxagen:pr_link'";
  const result = await chSelect<PullRequestLinkRow>({
    query: `SELECT toString(session_uuid) AS session,
      if(${linked}, attrs['pr_url'], attrs['pr.url']) AS url,
      argMin(if(${linked}, attrs['pr_number'], attrs['pr.number']), seq) AS number,
      argMin(if(${linked}, attrs['pr_repository'], attrs['pr.repository']), seq) AS repository,
      toString(min(seq)) AS first_seq
      FROM tacho_events FINAL
      WHERE session_uuid IN {sessions:Array(UUID)} AND chain_verified = true
        AND (${linked} OR attrs['pr.url'] != '')
      GROUP BY session, url
      HAVING url != ''
      ORDER BY session ASC, min(seq) ASC
      LIMIT {perSession:UInt32} BY session`,
    params: {
      sessions: [...sessionUuids],
      perSession: RUN_PULL_REQUEST_MAX,
    },
  });
  for (const row of result.data) {
    const pull = pullRequestOf(row);
    if (pull === null) continue;
    const list = out.get(row.session) ?? [];
    list.push(pull);
    out.set(row.session, list);
  }
  return out;
};

const files = schema.tachoSessionFiles;
const sessions = schema.tachoSessions;

/**
 * Sum git's reported change over every path the root session or one of its
 * subagent chains touched, per root. A path whose last complete snapshot
 * showed no change carries a null status and is left out.
 */
export const postgresRunGitDiffs: ReadRunGitDiffs = async (
  scope,
  sessionUuids,
) => {
  const out = new Map<string, { added: number; removed: number }>();
  if (sessionUuids.length === 0) return out;
  const roots = [...sessionUuids];
  const wanted = new Set(roots);
  // Grouped per chain, not per root: a CASE carrying bound parameters in both
  // SELECT and GROUP BY gets different placeholders, and Postgres refuses to
  // match them. Chains per page are few, so they fold into roots here.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        chain: sessions.sessionUuid,
        root: sessions.rootSessionUuid,
        added: sql<number>`coalesce(sum(${files.linesAdded}), 0)::int`.mapWith(
          Number,
        ),
        removed:
          sql<number>`coalesce(sum(${files.linesRemoved}), 0)::int`.mapWith(
            Number,
          ),
      })
      .from(files)
      .innerJoin(
        sessions,
        and(
          eq(sessions.id, files.sessionId),
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
        ),
      )
      .where(
        and(
          eq(files.orgId, scope.orgId),
          eq(files.workspaceId, scope.workspaceId),
          isNotNull(files.observedStatus),
          or(
            inArray(sessions.sessionUuid, roots),
            inArray(sessions.rootSessionUuid, roots),
          ),
        ),
      )
      .groupBy(sessions.sessionUuid, sessions.rootSessionUuid),
  );
  for (const row of rows) {
    const key = wanted.has(row.chain) ? row.chain : row.root;
    if (!wanted.has(key)) continue;
    const sum = out.get(key) ?? { added: 0, removed: 0 };
    out.set(key, {
      added: sum.added + row.added,
      removed: sum.removed + row.removed,
    });
  }
  return out;
};

/**
 * The lines a row shows. The harness's totals win: they count what the agent
 * changed over the whole session, including work it committed. They exist
 * only once the session reported them, so until then git's uncommitted
 * change stands in, labelled as such. A session with neither reads null, not
 * `+0 −0`: a harness that reports no totals is not a run that changed nothing.
 */
export function runDiffOf(
  session: { linesAdded?: number; linesRemoved?: number },
  git: { added: number; removed: number } | undefined,
): RunDiff | null {
  const added = session.linesAdded ?? 0;
  const removed = session.linesRemoved ?? 0;
  if (added > 0 || removed > 0)
    return { added, removed, basis: "harness_reported" };
  if (git !== undefined && (git.added > 0 || git.removed > 0))
    return { added: git.added, removed: git.removed, basis: "git_observed" };
  return null;
}

/**
 * Does a wrapped session belong on a filtered page? It has pull requests when
 * its frames name one or ingest counted a `pr_open` call. When the frames
 * could not be read (`links` undefined) the count alone decides.
 */
export function matchesPullRequestFilter(
  filter: RunPullRequestFilter,
  links: readonly RunPullRequest[] | undefined,
  opened: number | undefined,
): boolean {
  if (filter === "any") return true;
  const has = (links?.length ?? 0) > 0 || (opened ?? 0) > 0;
  return filter === "with" ? has : !has;
}
