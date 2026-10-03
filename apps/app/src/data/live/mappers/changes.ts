// get_change_set and get_revision_diff outputs to the change view models
// (ARCHITECTURE.md §3.4; ADR-292). Typed from the contracts' `_output`. A line
// count the forge did not report stays null. A file that kept its path has no
// `previousPath` in the contract and a null one in the view. The scope's own
// id is dropped, because an issue's id is its URL (INV-11).
import type { changeSetGet } from "@oxagen/oxagen/contracts/forge.changes.get";
import type { revisionDiffGet } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import type { z } from "zod";
import type { ChangeSet, RevisionDiff } from "@/data/contracts/changes";
import type { ContractOutput } from "@/server/kernel";

type ChangeSetOut = ContractOutput<typeof changeSetGet>;
type PullRequestOut = ChangeSetOut["pullRequests"][number];
type RepositoryOut = ChangeSetOut["repositories"][number];
type DiffOut = ContractOutput<typeof revisionDiffGet>;

type ChangeSetIn = z.input<typeof ChangeSet>;

function toPullRequest(
  pr: PullRequestOut,
): ChangeSetIn["pullRequests"][number] {
  return {
    id: pr.id,
    provider: pr.provider,
    repository: pr.repository,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    stateSeenAt: pr.stateSeenAt,
    revision:
      pr.revision === null
        ? null
        : {
            id: pr.revision.id,
            headSha: pr.revision.headSha,
            mergeBaseSha: pr.revision.mergeBaseSha,
            diffStatus: pr.revision.diffStatus,
            complete: pr.revision.complete,
            limitations: pr.revision.limitations,
            filesChanged: pr.revision.filesChanged,
            additions: pr.revision.additions,
            deletions: pr.revision.deletions,
            capturedAt: pr.revision.capturedAt,
          },
    files: pr.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    moreFiles: pr.moreFiles,
  };
}

function toRepository(
  repo: RepositoryOut,
): ChangeSetIn["repositories"][number] {
  return {
    provider: repo.provider,
    repository: repo.repository,
    pullRequests: repo.pullRequests,
    filesChanged: repo.filesChanged,
    additions: repo.additions,
    deletions: repo.deletions,
    files: repo.files.map((file) => ({
      path: file.path,
      pullRequestIds: file.pullRequestIds,
      additions: file.additions,
      deletions: file.deletions,
    })),
    moreFiles: repo.moreFiles,
  };
}

/** `get_change_set` → the change set a Changes panel draws. */
export function toChangeSet(out: ChangeSetOut): ChangeSetIn {
  return {
    scope: out.scope,
    pullRequests: out.pullRequests.map(toPullRequest),
    morePullRequests: out.morePullRequests,
    repositories: out.repositories.map(toRepository),
  };
}

/** `get_revision_diff` → one revision's files and hunks. */
export function toRevisionDiff(out: DiffOut): z.input<typeof RevisionDiff> {
  return {
    revisionId: out.revisionId,
    pullRequestId: out.pullRequestId,
    headSha: out.headSha,
    mergeBaseSha: out.mergeBaseSha,
    diffStatus: out.diffStatus,
    complete: out.complete,
    limitations: out.limitations,
    diffSha256: out.diffSha256,
    files: out.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      binary: file.binary,
      truncated: file.truncated,
    })),
    truncated: out.truncated,
  };
}
