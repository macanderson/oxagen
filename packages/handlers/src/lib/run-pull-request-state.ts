// The state of the pull requests a run's record names (#4129, ADR-192).
//
// A run's frames record a pull request's URL and nothing more. The state
// (open, draft, merged, closed) lives on the forge, and a list page cannot
// ask the forge once per row. `tacho.run_pull_requests` holds the state a
// forge last reported, one row per root session and URL, and three writers
// keep it current:
//
//   - the GitHub App's `pull_request` deliveries (github.pull-request.webhook.ts),
//   - a GitLab project hook's merge request deliveries (gitlab.webhook.ts),
//   - one live read when the link lands (run-pull-request-backfill.ts), since
//     the `opened` delivery can arrive before the frame that names the link.
//
// Forges deliver out of order, so every write carries the forge's own
// `updated_at` and a write older than the state held never replaces it.
//
// A delivery cannot name a run. It names a repository and a number, so rows
// are matched on (provider, lower-cased repository, number). A row whose
// repository no connection reaches keeps a null state, and the page says
// "status unknown".
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import type { RunPullRequest } from "@oxagen/oxagen/contracts/run.list";
import { and, eq, inArray, isNull, lte, or, type SQL } from "drizzle-orm";

const pulls = schema.tachoRunPullRequests;
const sessions = schema.tachoSessions;

export type PullRequestProvider = "github" | "gitlab";

/** What a webhook delivery can match a row on. */
export type ForgeKey = {
  provider: PullRequestProvider;
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: string;
  /** The pull request number, or the merge request iid. */
  number: number;
};

/** The largest number the `integer` column holds. */
const INT4_MAX = 2_147_483_647;

// The same shapes the app links (shared/pull-request-url.ts), with a trailing
// slash allowed: a recorded URL is a key here, never a link.
const GITHUB_PATH =
  /^\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)\/?$/;
const GITLAB_PATH =
  /^\/([A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/;

/**
 * The forge, repository and number a recorded URL names, or null. Only
 * github.com and gitlab.com: Oxagen holds no connection to any other forge,
 * so no delivery could ever update a row for one.
 */
export function forgeKeyOf(url: string): ForgeKey | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    return null;
  const host = parsed.hostname.toLowerCase();
  const match =
    host === "github.com"
      ? GITHUB_PATH.exec(parsed.pathname)
      : host === "gitlab.com"
        ? GITLAB_PATH.exec(parsed.pathname)
        : null;
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number > INT4_MAX) return null;
  return {
    provider: host === "github.com" ? "github" : "gitlab",
    repository: (match[1] ?? "").toLowerCase(),
    number,
  };
}

/** A state as a forge reported it, ready to store. */
export type ForgeState = {
  state: "open" | "merged" | "closed";
  /** Only an open pull request is a draft; the column's CHECK holds it. */
  draft: boolean;
  /** The forge's `updated_at`; null when the forge sent none. */
  sourceUpdatedAt: Date | null;
};

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * A GitHub pull request, from a webhook payload's `pull_request` or from the
 * REST client, as a state to store. GitHub says `closed` for a merged pull
 * request and reports the merge apart, so `merged` wins. Null when the
 * object names no state this column holds.
 */
export function githubForgeState(pr: {
  state?: unknown;
  merged?: unknown;
  draft?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
}): ForgeState | null {
  const sourceUpdatedAt = dateOf(pr.updated_at ?? pr.updatedAt);
  if (pr.merged === true)
    return { state: "merged", draft: false, sourceUpdatedAt };
  if (pr.state === "closed")
    return { state: "closed", draft: false, sourceUpdatedAt };
  if (pr.state === "open")
    return { state: "open", draft: pr.draft === true, sourceUpdatedAt };
  return null;
}

/**
 * A GitLab merge request as a state to store. `opened` is open, and
 * `locked` is too: GitLab locks a merge request for a moment while it
 * merges, and the merge's own delivery follows. Null for a state GitLab has
 * not documented.
 */
export function gitlabForgeState(mr: {
  state: string;
  draft?: boolean;
  updatedAt?: string | null;
}): ForgeState | null {
  const sourceUpdatedAt = dateOf(mr.updatedAt);
  switch (mr.state) {
    case "opened":
    case "locked":
      return { state: "open", draft: mr.draft === true, sourceUpdatedAt };
    case "merged":
      return { state: "merged", draft: false, sourceUpdatedAt };
    case "closed":
      return { state: "closed", draft: false, sourceUpdatedAt };
    default:
      return null;
  }
}

/**
 * The word `list_runs` answers for a stored row. The wire's `draft` is an
 * open row with its draft flag set. A word outside the column's CHECK reads
 * null, the same as no row.
 */
export function wireStateOf(row: {
  state: string | null;
  draft: boolean;
}): RunPullRequest["state"] {
  switch (row.state) {
    case "open":
      return row.draft ? "draft" : "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

/** What `list_runs` adds to a recorded link. */
export type StoredPullRequestState = {
  state: RunPullRequest["state"];
  /** RFC 3339; null when no forge has reported the pull request. */
  stateSeenAt: string | null;
};

/** Stored states by root session uuid, then by recorded URL. */
export type StoredPullRequestStates = Map<
  string,
  Map<string, StoredPullRequestState>
>;

/**
 * The stored rows for a page of root sessions, matched on the session's uuid
 * through `tacho.sessions`, since the rows hold the session's internal id.
 */
export function storedStatesQuery(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  sessionUuids: readonly string[],
) {
  return db
    .select({
      session: sessions.sessionUuid,
      url: pulls.url,
      state: pulls.state,
      draft: pulls.draft,
      stateSeenAt: pulls.stateSeenAt,
    })
    .from(pulls)
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, pulls.sessionId),
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
      ),
    )
    .where(
      and(
        eq(pulls.orgId, scope.orgId),
        eq(pulls.workspaceId, scope.workspaceId),
        inArray(sessions.sessionUuid, [...sessionUuids]),
      ),
    );
}

/** Read the stored states for a page of root sessions, one query. */
export async function readStoredPullRequestStates(
  scope: { orgId: string; workspaceId: string },
  sessionUuids: readonly string[],
): Promise<StoredPullRequestStates> {
  const out: StoredPullRequestStates = new Map();
  if (sessionUuids.length === 0) return out;
  const rows = await withTenantDb((tx) =>
    storedStatesQuery(tx, scope, sessionUuids),
  );
  for (const row of rows) {
    const byUrl =
      out.get(row.session) ?? new Map<string, StoredPullRequestState>();
    byUrl.set(row.url, {
      state: row.state === null ? null : wireStateOf(row),
      stateSeenAt: row.stateSeenAt?.toISOString() ?? null,
    });
    out.set(row.session, byUrl);
  }
  return out;
}

/**
 * The row a recorded link needs, with no state yet. A second insert for the
 * same session and URL does nothing, so a re-sent frame is harmless.
 */
export function insertRunPullRequest(
  tx: Pick<Tx, "insert">,
  row: {
    orgId: string;
    workspaceId: string;
    sessionId: string;
    url: string;
    key: ForgeKey;
  },
) {
  return tx
    .insert(pulls)
    .values({
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      url: row.url,
      provider: row.key.provider,
      repository: row.key.repository,
      number: row.key.number,
    })
    .onConflictDoNothing({ target: [pulls.sessionId, pulls.url] });
}

/**
 * The rows a write may replace: none holds a state newer than the one being
 * written. A write with no `updated_at` replaces only a row that has none
 * either, so an undated write never overwrites a dated one.
 */
function newerWins(sourceUpdatedAt: Date | null): SQL | undefined {
  return sourceUpdatedAt === null
    ? isNull(pulls.sourceUpdatedAt)
    : or(
        isNull(pulls.sourceUpdatedAt),
        lte(pulls.sourceUpdatedAt, sourceUpdatedAt),
      );
}

/**
 * Write a forge's state to every row in `where` that names the same pull
 * request, unless the row already holds a newer one. Answers the ids of the
 * rows it wrote.
 */
export function applyForgeState(
  tx: Pick<Tx, "update">,
  where: { orgId: string; workspaceId?: string },
  key: ForgeKey,
  forge: ForgeState,
  seenAt: Date,
) {
  return tx
    .update(pulls)
    .set({
      state: forge.state,
      draft: forge.state === "open" && forge.draft,
      stateSeenAt: seenAt,
      sourceUpdatedAt: forge.sourceUpdatedAt,
      updatedAt: seenAt,
    })
    .where(
      and(
        eq(pulls.orgId, where.orgId),
        where.workspaceId === undefined
          ? undefined
          : eq(pulls.workspaceId, where.workspaceId),
        eq(pulls.provider, key.provider),
        eq(pulls.repository, key.repository.toLowerCase()),
        eq(pulls.number, key.number),
        newerWins(forge.sourceUpdatedAt),
      ),
    )
    .returning({ id: pulls.id });
}
