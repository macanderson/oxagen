// cost.run_pr_outcomes: what each sealed run's pull requests became (#4491).
//
// One row per run and pull request, keyed by the run's public id (`arun_…` or
// `tse_…`, as `cost.run_totals.run_id` holds it) and `pr_key`
// (`github:owner/repo#N`). A run that opened no pull request has one row with
// `pr_key = 'none'` and the reason the run ended. The findings job reads the
// table to price spend that produced nothing: a pull request closed without
// merging, one a later change reverted, or no pull request at all.
//
// Each value carries the time Oxagen read it, and a null value is one never
// read, never a zero. `ci_state = 'none'` means the head commit was read and
// carried no checks. The hourly refresh (packages/handlers
// run-pr-outcomes-refresh.ts) and the GitHub pull request and push deliveries
// (packages/inngest-functions cost.run-pr-outcomes) write it. Like
// `run_totals`, it is a derived index and can be dropped and rebuilt.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgScopeMixin, uuidv7Default } from "./_mixins";
import { costSchema } from "./_schemas";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/** The `pr_key` of the row a run with no pull request gets. */
export const RUN_PR_OUTCOME_NO_PR_KEY = "none";
export const RUN_PR_STATES = ["open", "closed", "merged"] as const;
export const RUN_PR_CI_STATES = ["passed", "failed", "pending", "none"] as const;

export const runPrOutcomes = costSchema.table(
  "run_pr_outcomes",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** The run's public id: `arun_…` (evidence ledger) or `tse_…` (tacho). */
    runId: text("run_id").notNull(),
    runSource: text("run_source").notNull(),
    /** `github:owner/repo#N` in lower case, or `none` for a run with no pull request. */
    prKey: text("pr_key").notNull(),
    provider: text("provider"),
    /** Lower-cased `owner/name`, or the GitLab project path. */
    repository: text("repository"),
    number: integer("number"),
    url: text("url"),
    /** `open`, `closed` or `merged`; null until a forge reported one. */
    prState: text("pr_state"),
    prStateReadAt: ts("pr_state_read_at"),
    /**
     * When the hourly refresh last asked GitHub for this pull request, read or
     * not. The refresh reads the oldest first, so a pull request GitHub
     * refuses moves to the back of the queue instead of holding its front.
     */
    forgeReadAttemptedAt: ts("forge_read_attempted_at"),
    /**
     * When the pull request closed or merged. A delivery carries GitHub's own
     * `closed_at`. The scheduled read has no close time for a pull request
     * closed without merging, so it writes the `updated_at` it read on the
     * first read that found it closed, and the next delivery corrects it.
     */
    closedAt: ts("closed_at"),
    merged: boolean("merged").notNull().default(false),
    mergedAt: ts("merged_at"),
    mergeCommitSha: text("merge_commit_sha"),
    baseRef: text("base_ref"),
    headRef: text("head_ref"),
    headSha: text("head_sha"),
    /** Whether the head branch still exists; null until read. */
    headBranchExists: boolean("head_branch_exists"),
    headBranchReadAt: ts("head_branch_read_at"),
    /** `passed`, `failed`, `pending` or `none` (read, no checks); null until read. */
    ciState: text("ci_state"),
    ciReadAt: ts("ci_read_at"),
    reverted: boolean("reverted").notNull().default(false),
    /** The revert: `github:owner/repo#N` for a pull request, or `github:owner/repo@sha` for a commit. */
    revertedBy: text("reverted_by"),
    /** When the revert landed: the reverting pull request's merge, or the commit's time. */
    revertedAt: ts("reverted_at"),
    revertedReadAt: ts("reverted_read_at"),
    /** Why the run ended. Every row of the run carries it, and the `none` row exists for it. */
    terminalReason: text("terminal_reason"),
    terminalReasonReadAt: ts("terminal_reason_read_at"),
    /**
     * GitHub's `updated_at` for the state held here. An older delivery never
     * overwrites a newer one, because GitHub delivers out of order.
     */
    sourceUpdatedAt: ts("source_updated_at"),
  },
  (t) => ({
    runPrUniq: uniqueIndex("run_pr_outcomes_run_pr_uniq").on(t.runId, t.prKey),
    workspaceRunIdx: index("run_pr_outcomes_workspace_run_idx").on(
      t.orgId,
      t.workspaceId,
      t.runId,
    ),
    // The delivery lookup: every row one pull request's delivery updates.
    forgeIdx: index("run_pr_outcomes_forge_idx").on(
      t.orgId,
      t.workspaceId,
      t.repository,
      t.number,
    ),
    // The revert-commit lookup: the row whose merge commit a push reverts.
    mergeCommitIdx: index("run_pr_outcomes_merge_commit_idx")
      .on(t.orgId, t.workspaceId, t.mergeCommitSha)
      .where(sql`${t.mergeCommitSha} IS NOT NULL`),
    runSourceCheck: check(
      "run_pr_outcomes_run_source_check",
      sql`${t.runSource} IN ('ledger', 'tacho')`,
    ),
    runIdCheck: check(
      "run_pr_outcomes_run_id_check",
      sql`${t.runId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    providerCheck: check(
      "run_pr_outcomes_provider_check",
      sql`${t.provider} IS NULL OR ${t.provider} IN ('github', 'gitlab')`,
    ),
    keyCheck: check(
      "run_pr_outcomes_key_check",
      sql`(${t.prKey} = 'none' AND ${t.provider} IS NULL AND ${t.repository} IS NULL AND ${t.number} IS NULL) OR (${t.prKey} <> 'none' AND ${t.provider} IS NOT NULL AND ${t.repository} IS NOT NULL AND ${t.number} > 0)`,
    ),
    prStateCheck: check(
      "run_pr_outcomes_pr_state_check",
      sql`${t.prState} IS NULL OR ${t.prState} IN ('open', 'closed', 'merged')`,
    ),
    mergedCheck: check(
      "run_pr_outcomes_merged_check",
      sql`${t.prState} IS NULL OR (${t.prState} = 'merged') = ${t.merged}`,
    ),
    ciStateCheck: check(
      "run_pr_outcomes_ci_state_check",
      sql`${t.ciState} IS NULL OR ${t.ciState} IN ('passed', 'failed', 'pending', 'none')`,
    ),
    revertedCheck: check(
      "run_pr_outcomes_reverted_check",
      sql`NOT ${t.reverted} OR ${t.revertedBy} IS NOT NULL`,
    ),
  }),
);

// cost.run_pr_reverts: every revert Oxagen saw, kept until the outcome row it
// reverts exists (#4491).
//
// A revert can arrive before its target row does. The hourly refresh writes a
// run's rows, and learns a pull request's merge commit, only when it reads
// the run. A merged revert pull request or a pushed `git revert` commit that
// lands first would find no row to mark. The GitHub deliveries and the hourly
// refresh write each revert here before they mark or write any outcome row,
// and every refresh pass folds the reverts of the trailing 30 days into the
// rows it writes. A row keeps the first revert it gets.
//
// One revert names one target: a pull request by `number`, or a merge commit
// by `merge_commit_sha` on the branch the reverting commit landed on. Rows
// older than the outcome window are pruned hourly. Like `run_pr_outcomes`, it
// is a derived index.
export const runPrReverts = costSchema.table(
  "run_pr_reverts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Lower-cased `owner/name` of the reverted pull request or merge commit. */
    repository: text("repository").notNull(),
    /** The reverted pull request, or null when the target is a merge commit. */
    number: integer("number"),
    /** The reverted merge commit, or null when the target is a pull request. */
    mergeCommitSha: text("merge_commit_sha"),
    /**
     * The branch the reverting commit landed on. A merge commit target must
     * have merged into it. Null matches any branch.
     */
    branch: text("branch"),
    /** The revert: `github:owner/repo#N` for a pull request, or `github:owner/repo@sha` for a commit. */
    revertedBy: text("reverted_by").notNull(),
    /** When the revert landed: the reverting pull request's merge, or the commit's time. */
    revertedAt: ts("reverted_at"),
    /** When Oxagen saw the revert. */
    readAt: ts("read_at").notNull(),
  },
  (t) => ({
    // One row per revert and target. A commit pushed to two branches is two
    // rows, since only one of them may be the branch its target merged into.
    revertUniq: unique("run_pr_reverts_uniq")
      .on(
        t.orgId,
        t.workspaceId,
        t.revertedBy,
        t.repository,
        t.number,
        t.mergeCommitSha,
        t.branch,
      )
      .nullsNotDistinct(),
    // The refresh's read: one workspace's reverts in the window.
    workspaceReadIdx: index("run_pr_reverts_workspace_read_idx").on(
      t.orgId,
      t.workspaceId,
      t.readAt,
    ),
    // The hourly prune across every workspace.
    readIdx: index("run_pr_reverts_read_idx").on(t.readAt),
    targetCheck: check(
      "run_pr_reverts_target_check",
      sql`(${t.number} > 0 AND ${t.mergeCommitSha} IS NULL) OR (${t.number} IS NULL AND ${t.mergeCommitSha} IS NOT NULL)`,
    ),
  }),
);
