// Interjections (#3839): a question an agent paused its run to ask a person,
// and the answer the person gave. It is not a tool call waiting on approval,
// so it lives beside `agent.approval_requests` rather than in it.
//
// The run is a public id rather than a foreign key, as on approval_requests:
// both kinds of run this product tracks have to be representable, the
// ledger's `agent_runs` (`arun_…`) and the wrapped `tacho.sessions`
// (`tse_…`), and no one table holds both. Rows are never soft-deleted,
// matching approval_requests.
//
// The migration that creates the table and its tenant policy is written with
// the change that lands this schema source.
//
// A row has a kind (#3941). `question` is an agent asking in its own words
// (#3839). `repo_unknown` is a host holding a session that started in a
// repository the workspace has not bound: the ingest writes it from the
// host's `control.interject` frame, keyed on that frame so a re-sent batch
// writes no second row, and copies the frame's body onto it.
import {
  bigint,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin } from "./_mixins";

export const interjections = agentSchema.table(
  "interjections",
  {
    ...idMixin("inj"),
    ...auditMixin(),
    ...orgScopeMixin(),
    runPublicId: text("run_public_id").notNull(),
    // `org_ns.ws_ns.slug` (ADR-024); null when the writer recorded none.
    agentKey: text("agent_key"),
    question: text("question").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // The writer sets raised_at plus the skill's interjection timeout. After
    // it, the run carries on without an answer.
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    // All three stay null until a person answers.
    answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
    answer: text("answer"),
    answeredByUserId: uuid("answered_by_user_id"),
    // `question` or `repo_unknown`. Every row written before #3941 is a
    // question.
    kind: text("kind").notNull().default("question"),
    // The seq of the `control.interject` frame that raised the row, on the
    // run's own chain. Null on a question, which no frame raised.
    raisedSeq: bigint("raised_seq", { mode: "number" }),
    // The `control.interject` body as the host sealed it. Required on a
    // `repo_unknown` row, because the Run page renders the question, the
    // paths and the timeout from it.
    body: jsonb("body"),
    // The repository (`owner/name`) resolved from the body's remote digest.
    // Null until it is resolved, and when no connected repository matches.
    repository: text("repository"),
    // How a `repo_unknown` row was settled: `link`, `create` or `deny`.
    path: text("path"),
    // The receipt minted with the answer, shared by the row, the audit event
    // and the host's `control.answer` frame.
    receiptId: text("receipt_id").unique(),
  },
  (t) => ({
    runPublicIdCheck: check(
      "interjections_run_public_id_check",
      sql`${t.runPublicId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    answerCheck: check(
      "interjections_answer_check",
      sql`(${t.answeredAt} IS NULL AND ${t.answer} IS NULL AND ${t.answeredByUserId} IS NULL) OR (${t.answeredAt} IS NOT NULL AND ${t.answer} IS NOT NULL)`,
    ),
    windowCheck: check(
      "interjections_window_check",
      sql`${t.expiresAt} > ${t.raisedAt}`,
    ),
    // The readers refuse a blank question or agent key (list_interjections'
    // output and the app's InterjectionItem), and one such row would fail the
    // whole page. The table refuses them first. The answer's bound mirrors
    // answer_interjection's input.
    questionCheck: check(
      "interjections_question_check",
      sql`${t.question} <> ''`,
    ),
    agentKeyCheck: check(
      "interjections_agent_key_check",
      sql`${t.agentKey} IS NULL OR ${t.agentKey} <> ''`,
    ),
    answerLengthCheck: check(
      "interjections_answer_length_check",
      sql`${t.answer} IS NULL OR char_length(${t.answer}) <= 4000`,
    ),
    kindCheck: check(
      "interjections_kind_check",
      sql`${t.kind} IN ('question', 'repo_unknown')`,
    ),
    bodyCheck: check(
      "interjections_body_check",
      sql`${t.kind} = 'question' OR ${t.body} IS NOT NULL`,
    ),
    repositoryCheck: check(
      "interjections_repository_check",
      sql`${t.repository} IS NULL OR ${t.repository} <> ''`,
    ),
    pathCheck: check(
      "interjections_path_check",
      sql`${t.path} IS NULL OR ${t.path} IN ('link', 'create', 'deny')`,
    ),
    // Only a repo_unknown row takes a path.
    pathKindCheck: check(
      "interjections_path_kind_check",
      sql`${t.path} IS NULL OR ${t.kind} = 'repo_unknown'`,
    ),
    // Only the timeout answers deny, and the timeout is no person.
    pathDenyCheck: check(
      "interjections_path_deny_check",
      sql`${t.path} IS DISTINCT FROM 'deny' OR ${t.answeredByUserId} IS NULL`,
    ),
    receiptIdCheck: check(
      "interjections_receipt_id_check",
      sql`${t.receiptId} IS NULL OR (${t.receiptId} ~ '^rcp_[0-9a-z]+$' AND ${t.answeredAt} IS NOT NULL)`,
    ),
    // One row per raising frame, so a re-sent batch inserts nothing.
    raisedFrameUq: uniqueIndex("interjections_raised_frame_uq")
      .on(t.workspaceId, t.runPublicId, t.raisedSeq)
      .where(sql`raised_seq IS NOT NULL`),
    // The open queue list_interjections and get_nav_counts read.
    openIdx: index("interjections_open_idx")
      .on(t.orgId, t.workspaceId, t.expiresAt)
      .where(sql`answered_at IS NULL`),
    // One run's questions, for the Run page and a run filter.
    runIdx: index("interjections_run_idx").on(t.workspaceId, t.runPublicId),
  }),
);
