// The change view models (ADR-292): what `get_change_set` answers for a run,
// a work order, a work item, or an issue, and what `get_revision_diff`
// answers for one pull request revision. Both read Oxagen's own pull request
// store (ADR-288), never GitHub or GitLab.
//
// A pull request's net change is its revision: the diff from its merge base
// to its latest head. The roll-up joins the files of every pull request in a
// repository and sums their line counts. A pull request closed without
// merging is listed and left out of the roll-up. Hunks from two pull requests
// are never joined into one, because each starts from its own merge base.
//
// A line count the forge did not report is null here, never zero (INV-08).
// The scope's own id is not carried: an issue is named by its URL, which is
// not a public id (INV-11), and the page that asked already knows it.
import { z } from "zod";
import { PublicId } from "./common";

const Count = z.number().int().nonnegative();

export const ChangeSetScope = z.enum(["run", "work_order", "work_item", "issue"]);
export type ChangeSetScope = z.infer<typeof ChangeSetScope>;

/** Whether a revision's bytes are kept, and why not when they are not. */
const DiffStatus = z.enum([
  "stored",
  "too_large",
  "unreadable",
  "unconfigured",
]);

const FileStatus = z.enum([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
]);

const ChangedFile = z.object({
  path: z.string(),
  /** The path before a rename; null when the file kept its path. */
  previousPath: z.string().nullable(),
  status: FileStatus,
  additions: Count.nullable(),
  deletions: Count.nullable(),
});

/** The stored revision of a pull request's latest head. */
const Revision = z.object({
  /** `prv_…`: what `get_revision_diff` reads the hunks by. */
  id: PublicId,
  headSha: z.string(),
  mergeBaseSha: z.string().nullable(),
  diffStatus: DiffStatus,
  /** True when the stored bytes hold every file's change in full. */
  complete: z.boolean(),
  limitations: z.array(z.string()),
  filesChanged: Count.nullable(),
  additions: Count.nullable(),
  deletions: Count.nullable(),
  capturedAt: z.string(),
});

const ChangeSetPullRequest = z.object({
  /** `fpr_…` */
  id: PublicId,
  provider: z.enum(["github", "gitlab"]),
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string().nullable(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  headSha: z.string(),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  /** When a forge last reported the pull request. */
  stateSeenAt: z.string(),
  /** Null until Oxagen captures a revision for the pull request. */
  revision: Revision.nullable(),
  files: z.array(ChangedFile),
  /** True when the revision lists more files than this entry carries. */
  moreFiles: z.boolean(),
});

const ChangeSetRepository = z.object({
  provider: z.enum(["github", "gitlab"]),
  repository: z.string(),
  /** Pull requests in the roll-up: every one listed except those closed without merging. */
  pullRequests: Count,
  filesChanged: Count,
  /** Summed over the roll-up; null when any revision in it has no counts. */
  additions: Count.nullable(),
  deletions: Count.nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      /** Each pull request in the roll-up that changed the path. */
      pullRequestIds: z.array(PublicId),
      additions: Count.nullable(),
      deletions: Count.nullable(),
    }),
  ),
  moreFiles: z.boolean(),
});

/** The pull requests one scope produced, and their change rolled up by repository. */
export const ChangeSet = z.object({
  scope: ChangeSetScope,
  pullRequests: z.array(ChangeSetPullRequest),
  /** True when more pull requests are linked than one answer lists. */
  morePullRequests: z.boolean(),
  repositories: z.array(ChangeSetRepository),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

/** The most paths one `get_revision_diff` read names. */
export const REVISION_DIFF_PATHS_MAX = 100;

const RevisionDiffFile = ChangedFile.extend({
  /**
   * The file's hunks from its first `@@` line. Null when the bytes are not
   * kept, the file is binary, or the answer ran out of room before it.
   */
  patch: z.string().nullable(),
  binary: z.boolean(),
  /** True when the file's hunks were cut at its cap. */
  truncated: z.boolean(),
});

/** One revision's diff, split into files, as the store keeps it. */
export const RevisionDiff = z.object({
  /** `prv_…` */
  revisionId: PublicId,
  /** `fpr_…` */
  pullRequestId: PublicId,
  headSha: z.string(),
  mergeBaseSha: z.string().nullable(),
  diffStatus: DiffStatus,
  complete: z.boolean(),
  limitations: z.array(z.string()),
  /** The sha256 the stored bytes matched; null when none are stored. */
  diffSha256: z.string().nullable(),
  files: z.array(RevisionDiffFile),
  /** True when the answer's total cap left later files without hunks. */
  truncated: z.boolean(),
});
export type RevisionDiff = z.infer<typeof RevisionDiff>;
