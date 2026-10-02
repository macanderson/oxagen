// code-repo-check/request.ts: which workspaces a pull request delivery asks
// to check, and the request itself (S2b, #5058).
//
// A pull request in a code repository gets the Oxagen check from each
// workspace that links the repository: a head with role `linked` in
// `ingestion.repository_binding_heads`. A repository that any workspace holds
// as its steering repo gets nothing here, because its pull requests are
// steering PRs and carry the `Oxagen steering` check already.
//
// The request is one `code-repo/check.requested` event per workspace. Its id
// names the head and base commits, so a redelivered webhook asks once.
//
// A pull request that closes sends the same event with `closed` set, so the
// job settles the statements the check stored for it (ADR-254): closed
// without merging they go, and merged they stay. Its id names the close.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import type { GitLabMergeRequestEvent } from "@oxagen/gitlab";
import type {
  CodeRepoCheckRequest,
  CodeRepoProvider,
  CodeRepoPullRequestClose,
} from "@oxagen/inngest-functions/code-repo-check-runner";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { eventClient } from "../event-client";

export interface CheckScope {
  orgId: string;
  workspaceId: string;
}

/** One check request, as the event client sends it. */
export interface CodeRepoCheckEvent {
  id: string;
  name: "code-repo/check.requested";
  data: CodeRepoCheckRequest;
}

/** The pull request a delivery names, with the commits the check reads. */
export interface PullRequestHead {
  repositoryId: string;
  fullName: string;
  number: number;
  url: string;
  headSha: string;
  base: string;
}

/** How a pull request closed, and the commit a merge made when the host names it. */
export interface PullRequestClose {
  closed: CodeRepoPullRequestClose;
  mergeCommitSha: string | null;
}

/** One binding head for a repository. */
export interface HeadRow {
  orgId: string;
  workspaceId: string;
  role: string;
}

/** Where the routing reads binding heads. */
export interface LinkedScopeDeps {
  /** Every head for the repository on the shared Postgres plane. */
  sharedHeads(provider: CodeRepoProvider, repositoryId: string): Promise<HeadRow[]>;
  /** Every workspace of an organization on a dedicated Postgres plane (ADR-042). */
  dedicatedScopes(): Promise<CheckScope[]>;
  /** The heads one dedicated-plane workspace holds for the repository. */
  headsOnPlane(
    scope: CheckScope,
    provider: CodeRepoProvider,
    repositoryId: string,
  ): Promise<HeadRow[]>;
}

const headColumns = {
  orgId: schema.repositoryBindingHeads.orgId,
  workspaceId: schema.repositoryBindingHeads.workspaceId,
  role: schema.repositoryBindingHeads.role,
};

function sharedHeads(provider: CodeRepoProvider, repositoryId: string): Promise<HeadRow[]> {
  // tenancy: webhook routing before any tenant is known. The route verified
  // the delivery's signature or token, and this reads only the org id,
  // workspace id, and role of the heads filtered by the host's immutable
  // repository id that the delivery names.
  return withSystemDb((tx) =>
    tx
      .select(headColumns)
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.provider, provider),
          eq(schema.repositoryBindingHeads.providerRepositoryId, repositoryId),
        ),
      ),
  );
}

function dedicatedScopes(): Promise<CheckScope[]> {
  // tenancy: webhook routing has to learn which organizations live on a
  // dedicated plane before it can scope anything. It reads only org_id and
  // workspace_id from the control plane, filtered to live dedicated Postgres
  // planes, and reads no tenant row. Each head is then read in its own scope.
  return withSystemDb((tx) =>
    tx
      .select({ orgId: schema.workspaces.orgId, workspaceId: schema.workspaces.id })
      .from(schema.workspaces)
      .innerJoin(schema.dataPlanes, eq(schema.dataPlanes.orgId, schema.workspaces.orgId))
      .where(
        and(
          eq(schema.dataPlanes.kind, "postgres"),
          eq(schema.dataPlanes.mode, "dedicated"),
          isNull(schema.dataPlanes.deletedAt),
        ),
      ),
  );
}

function headsOnPlane(
  scope: CheckScope,
  provider: CodeRepoProvider,
  repositoryId: string,
): Promise<HeadRow[]> {
  return runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select(headColumns)
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.orgId, scope.orgId),
            eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
            eq(schema.repositoryBindingHeads.provider, provider),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repositoryId),
          ),
        ),
    ),
  );
}

/** The binding heads in Postgres: the shared plane, then each dedicated one. */
export const postgresLinkedScopes: LinkedScopeDeps = {
  sharedHeads,
  dedicatedScopes,
  headsOnPlane,
};

/** The GitHub pull request actions that put a new head or base in front of the check. */
const GITHUB_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited"]);

/** The GitLab merge request actions that can bring a new head. */
const GITLAB_ACTIONS = new Set(["open", "reopen", "update"]);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const idOf = (v: unknown): string | null =>
  typeof v === "number" || (typeof v === "string" && v.length > 0) ? String(v) : null;

type GitHubPullRequest = {
  number?: unknown;
  state?: unknown;
  merged?: unknown;
  merge_commit_sha?: unknown;
  html_url?: unknown;
  head?: { sha?: unknown };
  base?: { sha?: unknown };
};

/** The pull request a GitHub delivery names in the given state, or null when a field is missing. */
function githubHeadOf(body: Record<string, unknown>, state: "open" | "closed"): PullRequestHead | null {
  const pr = (body.pull_request ?? {}) as GitHubPullRequest;
  const repository = (body.repository ?? {}) as { id?: unknown; full_name?: unknown };
  const repositoryId = idOf(repository.id);
  const fullName = str(repository.full_name);
  const number = typeof pr.number === "number" && Number.isInteger(pr.number) ? pr.number : null;
  const headSha = str(pr.head?.sha);
  const base = str(pr.base?.sha);
  if (pr.state !== state || !repositoryId || !fullName || number === null || !headSha || !base)
    return null;
  return {
    repositoryId,
    fullName,
    number,
    url: str(pr.html_url) ?? `https://github.com/${fullName}/pull/${number}`,
    headSha,
    base,
  };
}

/**
 * The pull request a GitHub `pull_request` delivery names, or null when the
 * action cannot change what the check reads or the pull request is closed.
 */
export function githubPullRequestHead(body: Record<string, unknown>): PullRequestHead | null {
  if (!GITHUB_ACTIONS.has(str(body.action) ?? "")) return null;
  return githubHeadOf(body, "open");
}

/**
 * The pull request a GitHub `closed` delivery names, and whether it merged,
 * or null for any other delivery.
 */
export function githubPullRequestClose(
  body: Record<string, unknown>,
): { head: PullRequestHead; close: PullRequestClose } | null {
  if (str(body.action) !== "closed") return null;
  const head = githubHeadOf(body, "closed");
  if (head === null) return null;
  const pr = (body.pull_request ?? {}) as GitHubPullRequest;
  const merged = pr.merged === true;
  return {
    head,
    close: {
      closed: merged ? "merged" : "unmerged",
      mergeCommitSha: merged ? str(pr.merge_commit_sha) : null,
    },
  };
}

/**
 * The merge request a GitLab delivery names, or null when it is not open or
 * names no head commit. The page URL comes from the payload, or else from
 * the project path.
 */
export function gitlabMergeRequestHead(
  event: GitLabMergeRequestEvent,
  body: unknown,
): PullRequestHead | null {
  if (event.state !== "opened" || event.lastCommitSha === null) return null;
  if (event.action !== null && !GITLAB_ACTIONS.has(event.action)) return null;
  const attributes = ((body ?? {}) as { object_attributes?: { url?: unknown } })
    .object_attributes;
  return {
    repositoryId: event.projectId,
    fullName: event.projectPathWithNamespace,
    number: event.iid,
    url:
      str(attributes?.url) ??
      `https://gitlab.com/${event.projectPathWithNamespace}/-/merge_requests/${event.iid}`,
    headSha: event.lastCommitSha,
    base: event.targetBranch,
  };
}

/** The GitLab merge request actions that close one. */
const GITLAB_CLOSE_ACTIONS = new Set(["close", "merge"]);

/**
 * The merge request a GitLab `close` or `merge` delivery names, and whether
 * it merged, or null for any other delivery or one that names no head commit.
 */
export function gitlabMergeRequestClose(
  event: GitLabMergeRequestEvent,
  body: unknown,
): { head: PullRequestHead; close: PullRequestClose } | null {
  if (!GITLAB_CLOSE_ACTIONS.has(event.action ?? "")) return null;
  if ((event.state !== "merged" && event.state !== "closed") || event.lastCommitSha === null)
    return null;
  const head = gitlabMergeRequestHead({ ...event, state: "opened", action: null }, body);
  if (head === null) return null;
  const merged = event.state === "merged";
  return {
    head,
    close: {
      closed: merged ? "merged" : "unmerged",
      mergeCommitSha: merged ? event.mergeCommitSha : null,
    },
  };
}

/**
 * The workspaces that link a repository. None when any workspace holds it as
 * its steering repo, so a steering PR is never checked twice.
 */
export async function linkedScopes(
  provider: CodeRepoProvider,
  repositoryId: string,
  deps: LinkedScopeDeps = postgresLinkedScopes,
): Promise<CheckScope[]> {
  const rows = await deps.sharedHeads(provider, repositoryId);
  const read = new Set(rows.map((row) => row.workspaceId));
  // An organization on a dedicated Postgres plane keeps its binding heads on
  // that plane, out of the shared read above.
  for (const scope of await deps.dedicatedScopes()) {
    if (read.has(scope.workspaceId)) continue;
    rows.push(...(await deps.headsOnPlane(scope, provider, repositoryId)));
  }
  if (rows.some((row) => row.role === "steering")) return [];
  const scopes = new Map<string, CheckScope>();
  for (const row of rows)
    if (row.role === "linked")
      scopes.set(row.workspaceId, { orgId: row.orgId, workspaceId: row.workspaceId });
  return [...scopes.values()];
}

/** One check request for one workspace, or with `close`, one settlement. */
export function checkEvent(
  scope: CheckScope,
  provider: CodeRepoProvider,
  head: PullRequestHead,
  credential: { installationId: number } | { connectionId: string },
  close: PullRequestClose | null = null,
): CodeRepoCheckEvent {
  const prefix = `${scope.workspaceId}:${provider}:${head.repositoryId}`;
  return {
    id:
      close === null
        ? `code-repo-check:${prefix}:${head.number}:${head.headSha}:${head.base}`
        : `code-repo-check:${prefix}:${head.number}:${close.closed}:${head.headSha}`,
    name: "code-repo/check.requested",
    data: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      provider,
      repositoryId: head.repositoryId,
      fullName: head.fullName,
      number: head.number,
      url: head.url,
      headSha: head.headSha,
      base: head.base,
      installationId: "installationId" in credential ? credential.installationId : null,
      connectionId: "connectionId" in credential ? credential.connectionId : null,
      key: `${prefix}:${head.number}`,
      closed: close?.closed ?? null,
      mergeCommitSha: close?.mergeCommitSha ?? null,
    },
  };
}

/** The check requests a GitHub `pull_request` delivery makes. */
export async function githubCodeCheckRequests(
  args: { body: Record<string, unknown>; installationId: string | null },
  deps: LinkedScopeDeps = postgresLinkedScopes,
): Promise<CodeRepoCheckEvent[]> {
  const installationId = Number(args.installationId);
  if (!Number.isInteger(installationId) || installationId <= 0) return [];
  const closed = githubPullRequestClose(args.body);
  const head = closed?.head ?? githubPullRequestHead(args.body);
  if (head === null) return [];
  const scopes = await linkedScopes("github", head.repositoryId, deps);
  return scopes.map((scope) =>
    checkEvent(scope, "github", head, { installationId }, closed?.close ?? null),
  );
}

/**
 * The check request a GitLab merge request delivery makes, or null. A GitLab
 * connection belongs to one workspace, and its token reads one project, so
 * only that workspace is asked, in its own tenant scope, and only when it
 * links the project and does not hold it as its steering repo.
 */
export async function gitlabCodeCheckRequest(
  args: {
    scope: CheckScope;
    connectionId: string;
    event: GitLabMergeRequestEvent;
    body: unknown;
  },
  deps: Pick<LinkedScopeDeps, "headsOnPlane"> = postgresLinkedScopes,
): Promise<CodeRepoCheckEvent | null> {
  const closed = gitlabMergeRequestClose(args.event, args.body);
  const head = closed?.head ?? gitlabMergeRequestHead(args.event, args.body);
  if (head === null) return null;
  const rows = await deps.headsOnPlane(args.scope, "gitlab", head.repositoryId);
  if (rows.some((row) => row.role === "steering")) return null;
  if (!rows.some((row) => row.role === "linked")) return null;
  return checkEvent(
    args.scope,
    "gitlab",
    head,
    { connectionId: args.connectionId },
    closed?.close ?? null,
  );
}

/** Send the requests. Answers how many were sent. */
export async function requestCodeRepoChecks(
  events: readonly CodeRepoCheckEvent[],
  send: (events: CodeRepoCheckEvent[]) => Promise<unknown> = (batch) =>
    eventClient.send(
      batch.map((event) => ({
        id: event.id,
        name: "code-repo/check.requested" as const,
        data: { ...event.data },
      })),
    ),
): Promise<number> {
  if (events.length === 0) return 0;
  await send([...events]);
  return events.length;
}
