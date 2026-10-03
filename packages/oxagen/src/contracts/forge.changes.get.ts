// get_change_set — the pull requests a run, a work order, a work item, or an
// issue produced, each with its latest stored revision, and their change
// rolled up by repository (ADR-292). Every fact comes from the forge store
// (ADR-288): the pull request, its revisions, and the links that tie it to
// runs, work orders, and issues. Nothing is read from GitHub or GitLab here.
//
// A pull request's net change is its latest revision: the diff from the merge
// base to its latest head. Across pull requests the change is rolled up by
// repository, as the union of files with summed line counts. A pull request
// closed without merging changed nothing, so it is listed and left out of the
// roll-up. Hunks from different pull requests are never composed into one,
// because each starts from its own merge base. `get_revision_diff` reads a
// revision's hunks.
import { z } from "zod";
import { registerCapability } from "../registry";

/** The most pull requests one answer lists. */
export const CHANGE_SET_MAX_PULL_REQUESTS = 100;
/** The most files one pull request's entry lists. */
export const CHANGE_SET_MAX_FILES_PER_PULL_REQUEST = 300;
/** The most files one repository's roll-up lists. */
export const CHANGE_SET_MAX_FILES_PER_REPOSITORY = 1000;

/**
 * The shape an id takes in each scope. The handler refuses an id that does not
 * fit its scope as `not_found`, since no row could match it.
 */
export const CHANGE_SET_ID_PATTERNS = {
  run: /^(arun|tse)_[0-9a-z]+$/,
  work_order: /^wo_[0-9A-Za-z]+$/,
  work_item: /^wi_[0-9A-Za-z]+$/,
  issue:
    /^https:\/\/(github\.com\/[^/\s]+\/[^/\s]+\/issues|gitlab\.com\/.+\/-\/issues)\/[1-9][0-9]*$/,
} as const;

export const CHANGE_SET_SCOPES = [
  "run",
  "work_order",
  "work_item",
  "issue",
] as const;
export type ChangeSetScope = (typeof CHANGE_SET_SCOPES)[number];

const fileSchema = z
  .object({
    path: z.string(),
    /** The path before a rename; absent when the file kept its path. */
    previousPath: z.string().optional(),
    status: z.enum([
      "added",
      "modified",
      "removed",
      "renamed",
      "copied",
      "changed",
    ]),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();

const revisionSchema = z
  .object({
    /** `prv_…`; pass it to `get_revision_diff` for the hunks. */
    id: z.string(),
    headSha: z.string(),
    /** The commit the diff starts from; null when the forge named none. */
    mergeBaseSha: z.string().nullable(),
    /**
     * `stored` when the bytes are kept; `too_large`, `unreadable`, or
     * `unconfigured` when they are not, with the file list kept either way.
     */
    diffStatus: z.enum(["stored", "too_large", "unreadable", "unconfigured"]),
    /** True when the stored bytes hold every file's change in full. */
    complete: z.boolean(),
    limitations: z.array(z.string()),
    filesChanged: z.number().int().nonnegative().nullable(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    diffBytes: z.number().int().nonnegative().nullable(),
    capturedAt: z.string(),
  })
  .strict();

export const changeSetPullRequestSchema = z
  .object({
    /** `fpr_…` */
    id: z.string(),
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
    /**
     * The revision of the latest head, or the newest one captured while the
     * latest head's is not; null when none is captured yet.
     */
    revision: revisionSchema.nullable(),
    files: z.array(fileSchema).max(CHANGE_SET_MAX_FILES_PER_PULL_REQUEST),
    /** True when the revision lists more files than this entry carries. */
    moreFiles: z.boolean(),
  })
  .strict();

const repositorySchema = z
  .object({
    provider: z.enum(["github", "gitlab"]),
    repository: z.string(),
    /** Pull requests in the roll-up: every one listed except those closed unmerged. */
    pullRequests: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    /** Summed over the roll-up; null when any revision in it has no counts. */
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            /** Each pull request in the roll-up that changed the path, `fpr_…`. */
            pullRequestIds: z.array(z.string()),
            additions: z.number().int().nonnegative().nullable(),
            deletions: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(CHANGE_SET_MAX_FILES_PER_REPOSITORY),
    moreFiles: z.boolean(),
  })
  .strict();

export const changeSetGet = registerCapability({
  name: "get_change_set",
  domain: "run",
  description:
    "Get the pull requests a run, a work order, a work item, or an issue produced, each with its latest stored revision and files, and their change rolled up by repository. Read from Oxagen's own pull request store, never from GitHub or GitLab.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      scope: z.enum(CHANGE_SET_SCOPES),
      /**
       * The run's public id (`arun_…` or `tse_…`), the work order's (`wo_…`),
       * the work item's (`wi_…`), or the issue's URL.
       */
      id: z.string().min(1).max(2048),
    })
    .strict(),
  output: z
    .object({
      scope: z.enum(CHANGE_SET_SCOPES),
      id: z.string(),
      pullRequests: z
        .array(changeSetPullRequestSchema)
        .max(CHANGE_SET_MAX_PULL_REQUESTS),
      /** True when more pull requests are linked than one answer lists. */
      morePullRequests: z.boolean(),
      repositories: z.array(repositorySchema),
    })
    .strict(),
});

export type ChangeSetGetInput = z.output<typeof changeSetGet.input>;
export type ChangeSetGetOutput = z.output<typeof changeSetGet.output>;
export type ChangeSetPullRequest = z.output<typeof changeSetPullRequestSchema>;
