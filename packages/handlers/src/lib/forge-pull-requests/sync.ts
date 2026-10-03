// The pull request sync's three steps (ADR-288), behind the runner seam that
// `forge.pull-request-sync` calls. Each step's reads and writes come in as
// dependencies, so the order and the rules are tested without a forge or a
// database, and the real ones run inside the event's own tenant scope.
//
//   upsert   Facts from the delivery, or one forge read when the event came
//            from a run's link and carried none. Then the row, the run link,
//            and the run's work orders whose brief changes this repository.
//            The head needs a capture when it has no revision, or when its
//            revision was recorded with no diff store and one exists now.
//   capture  The diff for the head, put in the store.
//   record   The revision row that names it.
import { withTenantDb } from "@oxagen/database";
import { createGitHubClient, GitHubApiError } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import { createGitLabClient, GitLabApiError } from "@oxagen/gitlab";
import type {
  ForgeClosingIssue,
  ForgePullRequestCapture,
  ForgePullRequestFacts,
  ForgePullRequestRecord,
  ForgePullRequestSyncRequest,
  ForgePullRequestSyncRunner,
  ForgePullRequestUpsert,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../../logger";
import { findWorkspaceGitLabConnection } from "../../repository.gitlab-connection";
import { resolveGitLabCredential } from "../gitlab-credential";
import { githubConnectionFor } from "../run-pull-request-backfill";
import {
  captureFrom,
  type ForgeDiffRead,
  readGithubDiff,
  readGitlabDiff,
} from "./capture";
import { type DiffStore, diffStore } from "./diff-store";
import { githubClientFacts, gitlabClientFacts } from "./facts";
import {
  linkRun,
  linkWorkOrders,
  replaceIssueLinks,
  recordRevision,
  revisionStatusOf,
  runPublicIdOf,
  type Scope,
  upsertPullRequest,
  workOrdersOf,
} from "./store";

type Target = NonNullable<ForgePullRequestUpsert["target"]>;
type FactsRead = ForgePullRequestFacts | "no_connection" | "unreadable";

export interface ForgeSyncDeps {
  /** One forge read for a pull request the event named only by its key. */
  readFacts(scope: Scope, request: ForgePullRequestSyncRequest): Promise<FactsRead>;
  upsert(
    scope: Scope,
    request: ForgePullRequestSyncRequest,
    facts: ForgePullRequestFacts,
    seenAt: Date,
  ): Promise<string>;
  revisionStatus(
    scope: Scope,
    pullRequestId: string,
    headSha: string,
  ): Promise<ForgePullRequestCapture["diffStatus"] | null>;
  runPublicId(scope: Scope, rootSessionUuid: string): Promise<string | null>;
  linkRun(
    scope: Scope,
    pullRequestId: string,
    runId: string,
    source: "opened" | "recorded",
  ): Promise<number>;
  workOrdersOf(scope: Scope, runId: string, repository: string): Promise<string[]>;
  linkWorkOrders(
    scope: Scope,
    pullRequestId: string,
    orderIds: readonly string[],
    runId: string,
  ): Promise<number>;
  store(): DiffStore | null;
  readDiff(
    scope: Scope,
    request: ForgePullRequestSyncRequest,
    target: Target,
    wantBytes: boolean,
  ): Promise<ForgeDiffRead | "no_connection">;
  record(
    scope: Scope,
    pullRequestId: string,
    target: Target,
    capture: ForgePullRequestCapture,
    at: Date,
  ): Promise<ForgePullRequestRecord>;
  /**
   * The issues the pull request's closing references name, or null when the
   * forge could not be asked (ADR-292). Absent, no issue is read.
   */
  readClosingIssues?(
    scope: Scope,
    request: ForgePullRequestSyncRequest,
    target: Target,
  ): Promise<ForgeClosingIssue[] | null>;
  /** Replace the pull request's issue links; answers the links held. */
  linkIssues?(
    scope: Scope,
    pullRequestId: string,
    issues: readonly ForgeClosingIssue[],
  ): Promise<number>;
  now(): Date;
}

function scopeOf(request: ForgePullRequestSyncRequest): Scope {
  return { orgId: request.orgId, workspaceId: request.workspaceId };
}

/** Step one: the row, its links, and whether the head needs a capture. */
export async function upsertObserved(
  deps: ForgeSyncDeps,
  request: ForgePullRequestSyncRequest,
): Promise<ForgePullRequestUpsert> {
  const scope = scopeOf(request);
  const facts = request.facts ?? (await deps.readFacts(scope, request));
  if (facts === "no_connection" || facts === "unreadable")
    return { outcome: facts, needsCapture: false, links: 0 };
  const pullRequestId = await deps.upsert(scope, request, facts, deps.now());
  let links = 0;
  if (request.link !== undefined) {
    const runId = await deps.runPublicId(scope, request.link.rootSessionUuid);
    if (runId !== null) {
      links += await deps.linkRun(
        scope,
        pullRequestId,
        runId,
        request.link.opened ? "opened" : "recorded",
      );
      const orders = await deps.workOrdersOf(scope, runId, facts.repository);
      links += await deps.linkWorkOrders(scope, pullRequestId, orders, runId);
    }
  }
  const held = await deps.revisionStatus(scope, pullRequestId, facts.headSha);
  const needsCapture =
    held === null || (held === "unconfigured" && deps.store() !== null);
  return {
    outcome: "recorded",
    pullRequestId,
    target: {
      headSha: facts.headSha,
      baseSha: facts.baseSha,
      baseRef: facts.baseRef,
      mergeBaseSha: facts.mergeBaseSha,
      providerRepositoryId: facts.providerRepositoryId,
      number: facts.number,
    },
    needsCapture,
    links,
  };
}

/** Step two: the head's diff, put in the store when one is configured. */
export async function captureObserved(
  deps: ForgeSyncDeps,
  request: ForgePullRequestSyncRequest,
  target: Target,
): Promise<ForgePullRequestCapture> {
  const scope = scopeOf(request);
  const store = deps.store();
  const read = await deps.readDiff(scope, request, target, store !== null);
  const capture = await captureFrom(scope, request, target, read, store);
  if (deps.readClosingIssues === undefined) return capture;
  return {
    ...capture,
    closingIssues: await deps.readClosingIssues(scope, request, target),
  };
}

/**
 * Step three: the revision row, then the issue links the capture read. A
 * capture that could not ask the forge (`closingIssues: null`) leaves the
 * links as they were.
 */
export async function recordObserved(
  deps: ForgeSyncDeps,
  request: ForgePullRequestSyncRequest,
  pullRequestId: string,
  target: Target,
  capture: ForgePullRequestCapture,
): Promise<ForgePullRequestRecord> {
  const scope = scopeOf(request);
  const recorded = await deps.record(scope, pullRequestId, target, capture, deps.now());
  if (Array.isArray(capture.closingIssues) && deps.linkIssues !== undefined)
    await deps.linkIssues(scope, pullRequestId, capture.closingIssues);
  return recorded;
}

/**
 * The issues a GitHub pull request's closing references name. A refusal or a
 * failure answers null, so the capture still records its diff and the links
 * stand as they were. An issue GitHub sent with no node id is left out: it
 * could not be matched to a work item.
 */
async function readGithubClosingIssues(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
  target: Target,
): Promise<ForgeClosingIssue[] | null> {
  if (request.provider !== "github") return null;
  const [owner = "", repo = ""] = request.repository.split("/");
  try {
    const connectionId = await githubConnectionFor(scope, owner);
    if (connectionId === null) return null;
    const client = createGitHubClient({
      token: await resolveGitHubToken({ ...scope, connectionId }),
    });
    const read = await client.listClosingIssues({
      owner,
      repo,
      number: target.number,
    });
    return read.issues.flatMap((issue) =>
      issue.nodeId === undefined
        ? []
        : [
            {
              nodeId: issue.nodeId,
              repository: `${issue.owner}/${issue.repo}`.toLowerCase(),
              number: issue.number,
              url: issue.url,
              title: issue.title,
              state: issue.state,
            },
          ],
    );
  } catch (err) {
    logger.warn(
      { err, repository: request.repository, number: target.number },
      "forge.pull-request-sync: the closing issues could not be read; the links stand",
    );
    return null;
  }
}

function unreadableStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 410;
}

async function readGithubFacts(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
): Promise<FactsRead> {
  const [owner = "", repo = ""] = request.repository.split("/");
  const connectionId = await githubConnectionFor(scope, owner);
  if (connectionId === null) return "no_connection";
  const client = createGitHubClient({
    token: await resolveGitHubToken({ ...scope, connectionId }),
  });
  try {
    const pr = await client.getPullRequest({ owner, repo, number: request.number });
    return githubClientFacts(request.repository, pr) ?? "unreadable";
  } catch (err) {
    if (err instanceof GitHubApiError && unreadableStatus(err.status))
      return "unreadable";
    throw err;
  }
}

async function readGitlabFacts(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
): Promise<FactsRead> {
  const connection = await findWorkspaceGitLabConnection(scope, {
    path: request.repository,
  });
  if (connection === null || connection.status !== "connected")
    return "no_connection";
  const credential = await resolveGitLabCredential({
    ...scope,
    connectionId: connection.id,
  });
  const client = createGitLabClient({ token: credential.token });
  try {
    const mr = await client.getMergeRequest({
      project: connection.config.projectId,
      iid: request.number,
    });
    return gitlabClientFacts(request.repository, mr) ?? "unreadable";
  } catch (err) {
    if (err instanceof GitLabApiError && unreadableStatus(err.status))
      return "unreadable";
    throw err;
  }
}

/** The real dependencies. The runner calls them inside the event's tenant scope. */
export const forgeSyncDeps: ForgeSyncDeps = {
  readFacts: (scope, request) =>
    request.provider === "github"
      ? readGithubFacts(scope, request)
      : readGitlabFacts(scope, request),
  upsert: (scope, request, facts, seenAt) =>
    withTenantDb((tx) =>
      upsertPullRequest(tx, scope, request.provider, facts, seenAt),
    ),
  revisionStatus: (_scope, pullRequestId, headSha) =>
    withTenantDb((tx) => revisionStatusOf(tx, pullRequestId, headSha)),
  runPublicId: (scope, rootSessionUuid) =>
    withTenantDb((tx) => runPublicIdOf(tx, scope, rootSessionUuid)),
  linkRun: (scope, pullRequestId, runId, source) =>
    withTenantDb((tx) => linkRun(tx, scope, pullRequestId, runId, source)),
  workOrdersOf: (scope, runId, repository) =>
    withTenantDb((tx) => workOrdersOf(tx, scope, runId, repository)),
  linkWorkOrders: (scope, pullRequestId, orderIds, runId) =>
    withTenantDb((tx) =>
      linkWorkOrders(tx, scope, pullRequestId, orderIds, runId),
    ),
  readClosingIssues: readGithubClosingIssues,
  linkIssues: (scope, pullRequestId, issues) =>
    withTenantDb((tx) => replaceIssueLinks(tx, scope, pullRequestId, issues)),
  store: diffStore,
  readDiff: (scope, request, target, wantBytes) =>
    request.provider === "github"
      ? readGithubDiff(scope, request, target, wantBytes)
      : readGitlabDiff(scope, request, target, wantBytes),
  async record(scope, pullRequestId, target, capture, at) {
    const written = await withTenantDb((tx) =>
      recordRevision(tx, scope, pullRequestId, target, capture, at),
    );
    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pullRequestId,
        headSha: target.headSha,
        diffStatus: written.diffStatus,
        bytes: capture.diffBytes,
      },
      "forge.pull-request-sync: recorded a pull request revision",
    );
    return written;
  },
  now: () => new Date(),
};

/**
 * The runner `register.ts` installs: the three steps with their real
 * dependencies, each in the event's own tenant scope.
 */
export function forgeSyncRunner(
  deps: ForgeSyncDeps = forgeSyncDeps,
): ForgePullRequestSyncRunner {
  const scoped = <T>(request: ForgePullRequestSyncRequest, fn: () => Promise<T>) =>
    runInTenantScope(scopeOf(request), fn);
  return {
    upsert: (request) => scoped(request, () => upsertObserved(deps, request)),
    capture: (request, _pullRequestId, target) =>
      scoped(request, () => captureObserved(deps, request, target)),
    record: (request, pullRequestId, target, capture) =>
      scoped(request, () =>
        recordObserved(deps, request, pullRequestId, target, capture),
      ),
  };
}
