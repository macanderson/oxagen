// The instruction-file statements the Oxagen check flagged on pull requests
// in a workspace's linked code repositories (S7, #4518; ADR-254).
//
// One row per statement. A row keeps what only the host can give: the
// repository, the pull request, the commit the check read, the file, the
// line, and the statement's text. It does not keep which steering record the
// statement repeats or contradicts. `list_code_repository_findings` compares
// each stored statement with the workspace's active records on every read, so
// a record revised or retired since the check ran changes the answer at once.
//
// A row follows its pull request. Each check of an open pull request replaces
// its rows, keeping the id and the proposal of a statement it finds again. A
// pull request closed without merging deletes its rows. A merged one keeps
// them, marked `merged`, until a later merge changes the file and the
// statement is gone from it.
//
// The migration that creates this table and its tenant policies is
// 20261002133000_code_repository_findings.sql.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idMixin, orgScopeMixin } from "./_mixins";
import { agentSchema } from "./_schemas";

export const codeRepositoryFindings = agentSchema.table(
  "code_repository_findings",
  {
    ...idMixin("crf"),
    ...orgScopeMixin(),
    provider: text("provider").notNull(),
    // GitHub's repository id or GitLab's project id: immutable across renames.
    providerRepositoryId: text("provider_repository_id").notNull(),
    // `owner/name`, or the GitLab project path, as the check read it.
    repository: text("repository").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    pullRequestUrl: text("pull_request_url").notNull(),
    // `open` while the pull request is open, `merged` once its lines reached
    // the default branch.
    pullRequestState: text("pull_request_state").notNull().default("open"),
    // The commit the check read.
    headSha: text("head_sha").notNull(),
    path: text("path").notNull(),
    line: integer("line").notNull(),
    statement: text("statement").notNull(),
    // The proposal promote_instruction_to_steering opened from the statement.
    proposalPublicId: text("proposal_public_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // A statement starts on one line of one file, so a check writes one row
    // for it.
    statementUniq: uniqueIndex("code_repository_findings_statement_uq").on(
      t.workspaceId,
      t.provider,
      t.providerRepositoryId,
      t.pullRequestNumber,
      t.path,
      t.line,
    ),
    repositoryIdx: index("code_repository_findings_repository_idx").on(
      t.orgId,
      t.workspaceId,
      t.provider,
      t.providerRepositoryId,
      t.path,
    ),
    providerCheck: check(
      "code_repository_findings_provider_check",
      sql`${t.provider} IN ('github','gitlab')`,
    ),
    stateCheck: check(
      "code_repository_findings_state_check",
      sql`${t.pullRequestState} IN ('open','merged')`,
    ),
    numberCheck: check(
      "code_repository_findings_number_check",
      sql`${t.pullRequestNumber} > 0 AND ${t.line} >= 1`,
    ),
    statementCheck: check(
      "code_repository_findings_statement_check",
      sql`char_length(${t.statement}) BETWEEN 1 AND 4000`,
    ),
    proposalCheck: check(
      "code_repository_findings_proposal_check",
      sql`${t.proposalPublicId} IS NULL OR ${t.proposalPublicId} ~ '^prp_[0-9A-Za-z]+$'`,
    ),
  }),
);
