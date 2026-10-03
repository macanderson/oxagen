// forge-pull-request-sync-runner.ts: the seam between the durable pull request
// sync (functions/forge.pull-request-sync.ts) and the code that performs it
// (ADR-288).
//
// The sync writes the `forge` tables, reads GitHub and GitLab, and puts diffs
// in object storage, all through `@oxagen/handlers`, and `@oxagen/handlers`
// depends on this package, so this package cannot import it. The handlers'
// register module installs the runner when the API process boots, before the
// Inngest route can invoke a function. `run-pull-request-backfill-runner.ts`
// is the same seam for the same reason.
//
// The runner has three parts so each is its own durable step: a failed
// database write retries the write alone, and never reads the forge again or
// puts the diff again.

/** A pull request as its forge reported it. Times are ISO 8601. */
export interface ForgePullRequestFacts {
  /** `github.com` or `gitlab.com`. */
  host: string;
  /** GitHub's repository id or GitLab's project id. */
  providerRepositoryId: string;
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: string;
  number: number;
  url: string;
  title: string | null;
  authorLogin: string | null;
  state: "open" | "merged" | "closed";
  draft: boolean;
  baseRef: string | null;
  headRef: string | null;
  headSha: string;
  /** The base branch's tip when the forge reported the pull request. */
  baseSha: string | null;
  /** The commit the diff starts from, when the forge named it. */
  mergeBaseSha: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /** The forge's own `updated_at`; null when it sent none. */
  sourceUpdatedAt: string | null;
}

/**
 * One `forge/pull-request.observed` event's data. A type alias, not an
 * interface, so it is assignable to the event client's
 * `Record<string, unknown>` data.
 */
export type ForgePullRequestSyncRequest = {
  orgId: string;
  workspaceId: string;
  provider: "github" | "gitlab";
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: string;
  number: number;
  /** Names the pull request within the workspace; the concurrency key. */
  pullKey: string;
  /** The facts a delivery carried. Absent, the sync reads the forge. */
  facts?: ForgePullRequestFacts;
  /** The run that recorded a link to the pull request. */
  link?: {
    /** The root session's `session_uuid`, as the frames carry it. */
    rootSessionUuid: string;
    /** True when a `pr_open` call recorded the link, so the run opened it. */
    opened: boolean;
  };
};

/** What the first step did. */
export interface ForgePullRequestUpsert {
  outcome: "recorded" | "no_connection" | "unreadable";
  /** The `forge.pull_requests` row; absent unless `recorded`. */
  pullRequestId?: string;
  /** The head the facts named, and what a capture needs to read its diff. */
  target?: {
    headSha: string;
    baseSha: string | null;
    baseRef: string | null;
    mergeBaseSha: string | null;
    providerRepositoryId: string;
    number: number;
  };
  /** True when that head has no stored diff yet. */
  needsCapture: boolean;
  /** Rows the links wrote, run and work orders together. */
  links: number;
}

/** One file a revision changed. */
export interface ForgeCapturedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number | null;
  deletions: number | null;
}

/** What the capture step found for a head commit. */
export interface ForgePullRequestCapture {
  diffStatus: "stored" | "too_large" | "unreadable" | "unconfigured";
  diffStore: string | null;
  diffKey: string | null;
  diffSha256: string | null;
  diffBytes: number | null;
  mergeBaseSha: string | null;
  files: ForgeCapturedFile[];
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  complete: boolean;
  limitations: string[];
}

/** What the record step wrote. */
export interface ForgePullRequestRecord {
  revisionId: string;
  diffStatus: ForgePullRequestCapture["diffStatus"];
  /** True only when this step stored the head's diff for the first time. */
  newlyStored: boolean;
}

export interface ForgePullRequestSyncRunner {
  upsert(request: ForgePullRequestSyncRequest): Promise<ForgePullRequestUpsert>;
  capture(
    request: ForgePullRequestSyncRequest,
    pullRequestId: string,
    target: NonNullable<ForgePullRequestUpsert["target"]>,
  ): Promise<ForgePullRequestCapture>;
  record(
    request: ForgePullRequestSyncRequest,
    pullRequestId: string,
    target: NonNullable<ForgePullRequestUpsert["target"]>,
    capture: ForgePullRequestCapture,
  ): Promise<ForgePullRequestRecord>;
}

let runner: ForgePullRequestSyncRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setForgePullRequestSyncRunner(
  next: ForgePullRequestSyncRunner,
): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function forgePullRequestSyncRunner(): ForgePullRequestSyncRunner {
  if (!runner)
    throw new Error(
      "[forge.pull-request-sync] no sync runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
