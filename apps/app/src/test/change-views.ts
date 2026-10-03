// Test support for the change views (ADR-292): change sets and revision
// diffs as the changes port answers them, for the ui components, the Run
// page, and the work item page. Two pull requests in one repository change
// one shared path, and each keeps its own revision.
import type {
  ChangeSet,
  ChangeSetScope,
  RevisionDiff,
} from "@/data/contracts/changes";

type Pull = ChangeSet["pullRequests"][number];
type Repository = ChangeSet["repositories"][number];

/** A change set with no pull request on record. */
export function emptyChangeSet(scope: ChangeSetScope = "run"): ChangeSet {
  return {
    scope,
    pullRequests: [],
    morePullRequests: false,
    repositories: [],
  };
}

/** An open pull request with a stored revision of two files. */
export function changePull(over: Partial<Pull> = {}): Pull {
  return {
    id: "fpr_482",
    provider: "github",
    repository: "acme/platform",
    number: 482,
    url: "https://github.com/acme/platform/pull/482",
    title: "Release 3.2",
    state: "open",
    headSha: "9f8e7d6c5b4a",
    baseRef: "main",
    headRef: "release/3.2",
    mergedAt: null,
    closedAt: null,
    stateSeenAt: "2026-10-03T09:00:00.000Z",
    revision: {
      id: "prv_482a",
      headSha: "9f8e7d6c5b4a",
      mergeBaseSha: "1a2b3c4d",
      diffStatus: "stored",
      complete: true,
      limitations: [],
      filesChanged: 2,
      additions: 12,
      deletions: 3,
      capturedAt: "2026-10-03T09:00:01.000Z",
    },
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 10,
        deletions: 3,
      },
      {
        path: "CHANGELOG.md",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 0,
      },
    ],
    moreFiles: false,
    ...over,
  };
}

/** A second pull request in the same repository, merged, that also changed `src/app.ts`. */
export function secondPull(over: Partial<Pull> = {}): Pull {
  return changePull({
    id: "fpr_490",
    number: 490,
    url: "https://github.com/acme/platform/pull/490",
    title: "Fix the release banner",
    state: "merged",
    headSha: "77aa88bb",
    mergedAt: "2026-10-03T10:00:00.000Z",
    revision: {
      id: "prv_490a",
      headSha: "77aa88bb",
      mergeBaseSha: "5e6f7a8b",
      diffStatus: "stored",
      complete: true,
      limitations: [],
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      capturedAt: "2026-10-03T10:00:01.000Z",
    },
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 4,
        deletions: 1,
      },
    ],
    ...over,
  });
}

/** The roll-up of the two pull requests above. */
export function changeRepo(over: Partial<Repository> = {}): Repository {
  return {
    provider: "github",
    repository: "acme/platform",
    pullRequests: 2,
    filesChanged: 2,
    additions: 16,
    deletions: 4,
    files: [
      {
        path: "src/app.ts",
        pullRequestIds: ["fpr_482", "fpr_490"],
        additions: 14,
        deletions: 4,
      },
      {
        path: "CHANGELOG.md",
        pullRequestIds: ["fpr_482"],
        additions: 2,
        deletions: 0,
      },
    ],
    moreFiles: false,
    ...over,
  };
}

/** Two pull requests in one repository, rolled up. */
export function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    scope: "run",
    pullRequests: [changePull(), secondPull()],
    morePullRequests: false,
    repositories: [changeRepo()],
    ...over,
  };
}

/** One revision's answer for one path, with the hunk given. */
export function revisionDiff(
  revisionId: string,
  path: string,
  patch: string | null,
  over: Partial<RevisionDiff> = {},
): RevisionDiff {
  return {
    revisionId,
    pullRequestId: revisionId === "prv_490a" ? "fpr_490" : "fpr_482",
    headSha: "9f8e7d6c5b4a",
    mergeBaseSha: "1a2b3c4d",
    diffStatus: "stored",
    complete: true,
    limitations: [],
    diffSha256: "ab".repeat(32),
    files: [
      {
        path,
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch,
        binary: false,
        truncated: false,
      },
    ],
    truncated: false,
    ...over,
  };
}
