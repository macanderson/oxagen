// The pull requests a workspace's forges deliver, the diff of each head
// commit, and the runs and work orders each pull request belongs to (ADR-288).
//
// `pull_requests` holds one row per workspace and pull request. It is keyed
// on the forge's own repository id, which survives a rename, and on the
// number. Every `pull_request` delivery and every link a run records keeps it
// current, so a pull request has a stored state from the first delivery, not
// only once a run has named it.
//
// `pull_request_revisions` holds one row per head commit. A push makes a new
// head and a new row. Each row names the diff the forge gave for that head
// against the merge base, stored in object storage under a tenant-first key,
// with its sha256 and size. A stored row never changes, so a check that read
// a diff can name the exact bytes it read. The row is keyed on the head
// alone: the base branch's tip moves on every delivery while the diff from
// the merge base stays the same.
//
// `pull_request_runs` and `pull_request_work_orders` are the two links. Each
// is many to many: a run can open several pull requests, a pull request can
// carry the work of several runs, and the same holds for work orders. A run
// is named by its public id (`arun_` or `tse_`), the form the cost tables use
// for both kinds of run. A work order is named by `work.orders.id`, with no
// foreign key across the schema boundary (see _schemas.ts).
//
// `pull_request_issues` links a pull request to each issue it closes, as the
// forge's closing references name them at its latest head (ADR-292). An issue
// is keyed by the forge's node id, the id `work.items.provider_id` carries
// (`issue:node:<id>`), so an issue a collector brought in as a work item and
// the pull requests that close it meet on one value.
//
// The migrations that create these tables and their tenant policies are
// 20261003120000_forge_pull_requests.sql and
// 20261003150000_forge_pull_request_issues.sql.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idMixin, orgScopeMixin, uuidv7Default } from "./_mixins";
import { forgeSchema } from "./_schemas";

/** The forges Oxagen connects to. */
export const FORGE_PROVIDERS = ["github", "gitlab"] as const;
export type ForgeProvider = (typeof FORGE_PROVIDERS)[number];

/** A pull request's state, as its forge last reported it. */
export const FORGE_PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export type ForgePullRequestState = (typeof FORGE_PULL_REQUEST_STATES)[number];

/**
 * What became of a head commit's diff.
 *
 * - `stored`: the bytes are in object storage at `diff_key`.
 * - `too_large`: the forge refused the diff, or it was over the byte cap. The
 *   file list may still be there.
 * - `unreadable`: the forge answered 403, 404 or 410, so the workspace's
 *   connection cannot read it.
 * - `unconfigured`: this deployment names no diff store.
 */
export const FORGE_DIFF_STATUSES = [
  "stored",
  "too_large",
  "unreadable",
  "unconfigured",
] as const;
export type ForgeDiffStatus = (typeof FORGE_DIFF_STATUSES)[number];

/** How a run came to be linked to a pull request. */
export const FORGE_RUN_LINK_SOURCES = ["opened", "recorded"] as const;
export type ForgeRunLinkSource = (typeof FORGE_RUN_LINK_SOURCES)[number];

const SHA = `'^[0-9a-f]{40}([0-9a-f]{24})?$'`;

export const forgePullRequests = forgeSchema.table(
  "pull_requests",
  {
    ...idMixin("fpr"),
    ...orgScopeMixin(),
    provider: text("provider").notNull(),
    // `github.com` or `gitlab.com`, lower-cased.
    host: text("host").notNull(),
    // GitHub's repository id or GitLab's project id: immutable across renames.
    providerRepositoryId: text("provider_repository_id").notNull(),
    // Lower-cased `owner/name`, or the GitLab project path, as last delivered.
    repository: text("repository").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    authorLogin: text("author_login"),
    state: text("state").notNull(),
    // Only an open pull request is a draft; the CHECK holds it.
    draft: boolean("draft").notNull().default(false),
    baseRef: text("base_ref"),
    headRef: text("head_ref"),
    headSha: text("head_sha").notNull(),
    // The base branch's tip when the forge last reported the pull request.
    baseSha: text("base_sha"),
    mergeCommitSha: text("merge_commit_sha"),
    mergedAt: timestamp("merged_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    // The forge's own `updated_at`. A write older than the one held never
    // replaces it, since forges deliver out of order.
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    stateSeenAt: timestamp("state_seen_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    forgeUniq: uniqueIndex("pull_requests_forge_uq").on(
      t.orgId,
      t.workspaceId,
      t.provider,
      t.host,
      t.providerRepositoryId,
      t.number,
    ),
    // A recorded link names a URL, so it is matched on the path and number.
    pathIdx: index("pull_requests_path_idx").on(
      t.orgId,
      t.workspaceId,
      t.provider,
      t.repository,
      t.number,
    ),
    providerCheck: check(
      "pull_requests_provider_check",
      sql`${t.provider} IN ('github','gitlab')`,
    ),
    stateCheck: check(
      "pull_requests_state_check",
      sql`${t.state} IN ('open','merged','closed')`,
    ),
    draftCheck: check(
      "pull_requests_draft_check",
      sql`${t.state} = 'open' OR ${t.draft} = false`,
    ),
    numberCheck: check("pull_requests_number_check", sql`${t.number} > 0`),
    shaCheck: check(
      "pull_requests_sha_check",
      sql`${t.headSha} ~ ${sql.raw(SHA)} AND (${t.baseSha} IS NULL OR ${t.baseSha} ~ ${sql.raw(SHA)}) AND (${t.mergeCommitSha} IS NULL OR ${t.mergeCommitSha} ~ ${sql.raw(SHA)})`,
    ),
  }),
);

/** One file a revision changed, as its forge listed it. */
export type ForgeRevisionFile = {
  path: string;
  /** The path before a rename; absent when the file kept its path. */
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number | null;
  deletions: number | null;
};

export const forgePullRequestRevisions = forgeSchema.table(
  "pull_request_revisions",
  {
    ...idMixin("prv"),
    ...orgScopeMixin(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => forgePullRequests.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    // The base branch's tip the forge reported beside this head.
    baseSha: text("base_sha"),
    // The commit the diff starts from, as the forge's compare named it.
    mergeBaseSha: text("merge_base_sha"),
    diffStatus: text("diff_status").notNull(),
    // Where the bytes are: the store's name and the object's key. Set exactly
    // when `diff_status` is `stored`.
    diffStore: text("diff_store"),
    diffKey: text("diff_key"),
    diffSha256: text("diff_sha256"),
    diffBytes: bigint("diff_bytes", { mode: "number" }),
    filesChanged: integer("files_changed"),
    additions: integer("additions"),
    deletions: integer("deletions"),
    files: jsonb("files").$type<ForgeRevisionFile[]>().notNull().default([]),
    // True when the stored bytes hold every file's change in full.
    complete: boolean("complete").notNull().default(false),
    // Why a revision is not complete, one word each, such as `file_too_large`.
    limitations: text("limitations").array().notNull().default(sql`'{}'`),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    headUniq: uniqueIndex("pull_request_revisions_head_uq").on(
      t.pullRequestId,
      t.headSha,
    ),
    capturedIdx: index("pull_request_revisions_captured_idx").on(
      t.orgId,
      t.workspaceId,
      t.pullRequestId,
      t.capturedAt,
    ),
    statusCheck: check(
      "pull_request_revisions_status_check",
      sql`${t.diffStatus} IN ('stored','too_large','unreadable','unconfigured')`,
    ),
    storedCheck: check(
      "pull_request_revisions_stored_check",
      sql`(${t.diffStatus} = 'stored') = (${t.diffKey} IS NOT NULL AND ${t.diffStore} IS NOT NULL AND ${t.diffSha256} IS NOT NULL AND ${t.diffBytes} IS NOT NULL)`,
    ),
    digestCheck: check(
      "pull_request_revisions_digest_check",
      sql`${t.diffSha256} IS NULL OR ${t.diffSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    shaCheck: check(
      "pull_request_revisions_sha_check",
      sql`${t.headSha} ~ ${sql.raw(SHA)} AND (${t.baseSha} IS NULL OR ${t.baseSha} ~ ${sql.raw(SHA)}) AND (${t.mergeBaseSha} IS NULL OR ${t.mergeBaseSha} ~ ${sql.raw(SHA)})`,
    ),
  }),
);

export const forgePullRequestRuns = forgeSchema.table(
  "pull_request_runs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => forgePullRequests.id, { onDelete: "cascade" }),
    // The run's public id: `arun_` for a ledger run, `tse_` for a wrapped one.
    runId: text("run_id").notNull(),
    source: text("source").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    linkUniq: uniqueIndex("pull_request_runs_link_uq").on(
      t.pullRequestId,
      t.runId,
    ),
    runIdx: index("pull_request_runs_run_idx").on(
      t.orgId,
      t.workspaceId,
      t.runId,
    ),
    runCheck: check(
      "pull_request_runs_run_check",
      sql`${t.runId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    sourceCheck: check(
      "pull_request_runs_source_check",
      sql`${t.source} IN ('opened','recorded')`,
    ),
  }),
);

export const forgePullRequestWorkOrders = forgeSchema.table(
  "pull_request_work_orders",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => forgePullRequests.id, { onDelete: "cascade" }),
    // `work.orders.id`.
    workOrderId: uuid("work_order_id").notNull(),
    // The run whose link brought the pull request to the order.
    runId: text("run_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    linkUniq: uniqueIndex("pull_request_work_orders_link_uq").on(
      t.pullRequestId,
      t.workOrderId,
    ),
    orderIdx: index("pull_request_work_orders_order_idx").on(
      t.orgId,
      t.workspaceId,
      t.workOrderId,
    ),
    runCheck: check(
      "pull_request_work_orders_run_check",
      sql`${t.runId} IS NULL OR ${t.runId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
  }),
);

export const forgePullRequestIssues = forgeSchema.table(
  "pull_request_issues",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => forgePullRequests.id, { onDelete: "cascade" }),
    // The forge's node id for the issue; `work.items.provider_id` names the
    // same issue as `issue:node:<id>`.
    issueNodeId: text("issue_node_id").notNull(),
    // Lower-cased `owner/name` of the repository that holds the issue.
    repository: text("repository").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    // `open` or `closed`, as the forge reported it when the link was read.
    state: text("state").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    linkUniq: uniqueIndex("pull_request_issues_link_uq").on(
      t.pullRequestId,
      t.issueNodeId,
    ),
    issueIdx: index("pull_request_issues_issue_idx").on(
      t.orgId,
      t.workspaceId,
      t.issueNodeId,
    ),
    urlIdx: index("pull_request_issues_url_idx").on(
      t.orgId,
      t.workspaceId,
      t.url,
    ),
    numberCheck: check(
      "pull_request_issues_number_check",
      sql`${t.number} > 0`,
    ),
    stateCheck: check(
      "pull_request_issues_state_check",
      sql`${t.state} IN ('open','closed')`,
    ),
  }),
);
