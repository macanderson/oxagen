// Memories, reflections, and memory PRs (steering-repo-spec, Memory and
// reflection; ADR-206, ADR-245).
//
// An agent's lessons wait here until the curator cites them in a memory PR.
// A memory keeps its row for life, and `state` says where it is: waiting,
// in_pr while an open memory PR cites it, promoted once its record merged,
// dismissed by a person, or retired when its file is gone or nothing used it
// for `retire_after_days` (ADR-245). A record that did not merge leaves a
// hash of each cited statement in `memory_rejections`, so the curator does
// not propose the lesson again without new evidence.
//
// `memory_uses` counts the runs that used each memory: a Claude Code run
// that read the memory's file, a harness's own count, or a citation. A
// memory's `use_count` and `last_used_at` are computed from its uses in the
// same transaction that writes them, and the curator ranks by them.
//
// A reflection is the memory an agent writes at the end of a run. Its tool
// grades and tool feedback go to the tool server's owner and never steer. The
// reflection row outlives its lessons, because retirement reads its lessons
// to find a steering record they contradict.
//
// The run is a public id, not a foreign key, as on agent.interjections: a run
// is either a ledger run (`arun_…`) or a wrapped session (`tse_…`), and no one
// table holds both. The agent is the lineage the run recorded, `null` when
// Oxagen could not tell.
//
// The migration that creates these tables and their tenant policies is
// 20260927021500_steering_memories.sql. 20261002003000_memory_uses.sql adds
// the lifecycle columns and `memory_uses`.
import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { idMixin, orgScopeMixin, uuidv7Default } from "./_mixins";

export const memoryReflections = agentSchema.table(
  "memory_reflections",
  {
    ...idMixin("rfl"),
    ...orgScopeMixin(),
    runPublicId: text("run_public_id").notNull(),
    agentLineage: text("agent_lineage"),
    source: text("source").notNull(),
    outcome: text("outcome").notNull(),
    summary: text("summary").notNull(),
    // { work: 1..5, tools: { "<server>__<tool>[@<version>]": 1..5 } }
    grades: jsonb("grades").notNull(),
    // reflection/v1 lessons, kept beside the memories they became.
    lessons: jsonb("lessons").notNull().default(sql`'[]'::jsonb`),
    toolFeedback: jsonb("tool_feedback").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runUniq: uniqueIndex("memory_reflections_run_uq").on(
      t.workspaceId,
      t.runPublicId,
    ),
    createdIdx: index("memory_reflections_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    runCheck: check(
      "memory_reflections_run_public_id_check",
      sql`${t.runPublicId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    sourceCheck: check(
      "memory_reflections_source_check",
      sql`${t.source} IN ('agent', 'digest')`,
    ),
    summaryCheck: check(
      "memory_reflections_summary_check",
      sql`${t.summary} <> ''`,
    ),
  }),
);

export const memoryPullRequests = agentSchema.table(
  "memory_prs",
  {
    ...idMixin("mpr"),
    ...orgScopeMixin(),
    provider: text("provider").notNull(),
    repository: text("repository").notNull(),
    branch: text("branch").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("open"),
    // [{ action, lineage, path, kind, memoryIds, statementHashes }], one per
    // record the PR proposes or retires.
    records: jsonb("records").notNull().default(sql`'[]'::jsonb`),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    prUniq: uniqueIndex("memory_prs_pr_uq").on(
      t.workspaceId,
      t.repository,
      t.number,
    ),
    openIdx: index("memory_prs_open_idx")
      .on(t.orgId, t.workspaceId)
      .where(sql`${t.status} = 'open'`),
    statusCheck: check(
      "memory_prs_status_check",
      sql`${t.status} IN ('open', 'merged', 'closed')`,
    ),
    settledCheck: check(
      "memory_prs_settled_check",
      sql`(${t.status} = 'open') = (${t.settledAt} IS NULL)`,
    ),
  }),
);

export const memories = agentSchema.table(
  "memories",
  {
    ...idMixin("mem"),
    ...orgScopeMixin(),
    agentLineage: text("agent_lineage"),
    runPublicId: text("run_public_id"),
    capture: text("capture").notNull(),
    statement: text("statement").notNull(),
    // sha256 of the normalized statement, the key a rejection matches.
    statementHash: text("statement_hash").notNull(),
    kind: text("kind").notNull().default("memory"),
    repos: jsonb("repos"),
    appliesTo: jsonb("applies_to"),
    tools: jsonb("tools"),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    // Where a pull_request or local_gateway memory came from: a PR URL, or a
    // harness and file path.
    source: text("source"),
    // The run, or the capture and source, plus the statement hash. A retried
    // write of the same lesson from the same place writes no second row.
    dedupeKey: text("dedupe_key").notNull(),
    reflectionId: uuid("reflection_id").references(
      () => memoryReflections.id,
      { onDelete: "set null" },
    ),
    // The memory PR that last cited the memory. It stays after the PR
    // settles, so a promoted memory names the PR that promoted it.
    memoryPrId: uuid("memory_pr_id").references(() => memoryPullRequests.id, {
      onDelete: "set null",
    }),
    // waiting, in_pr, promoted, dismissed, or retired (ADR-245).
    state: text("state").notNull().default("waiting"),
    // A Claude Code memory file's frontmatter `name`, `description`, and
    // `metadata.type` (user, feedback, project, or reference).
    label: text("label"),
    summary: text("summary"),
    memoryType: text("memory_type"),
    // The distinct runs in `memory_uses`, plus the uses a harness counted
    // with no run. Written with the uses, never on its own.
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
    // `deleted`: the file is gone or no longer holds the statement. `unused`:
    // no run used the memory for `retire_after_days`. The memory comes back
    // when its file holds the statement again, or when a run uses it.
    retiredReason: text("retired_reason"),
    // The lineage of the steering record that carries the memory: the record
    // its memory PR merged, or an active record that already said it.
    promotedLineage: text("promoted_lineage"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dedupeUniq: uniqueIndex("memories_dedupe_uq").on(
      t.workspaceId,
      t.dedupeKey,
    ),
    waitingIdx: index("memories_waiting_idx")
      .on(t.orgId, t.workspaceId, t.createdAt)
      .where(sql`${t.state} = 'waiting'`),
    prIdx: index("memories_pr_idx").on(t.memoryPrId),
    sourceIdx: index("memories_source_idx")
      .on(t.workspaceId, t.source)
      .where(sql`${t.source} IS NOT NULL`),
    captureCheck: check(
      "memories_capture_check",
      sql`${t.capture} IN ('remember', 'pull_request', 'local_gateway', 'import')`,
    ),
    stateCheck: check(
      "memories_state_check",
      sql`${t.state} IN ('waiting', 'in_pr', 'promoted', 'dismissed', 'retired')`,
    ),
    // A retired memory says when and why. Any other state carries neither.
    retiredCheck: check(
      "memories_retired_check",
      sql`(${t.state} = 'retired') = (${t.retiredAt} IS NOT NULL) AND (${t.state} = 'retired') = (${t.retiredReason} IS NOT NULL) AND (${t.retiredReason} IS NULL OR ${t.retiredReason} IN ('deleted', 'unused'))`,
    ),
    // A promoted memory names its record. A retired one keeps the lineage,
    // so it comes back promoted.
    promotedCheck: check(
      "memories_promoted_check",
      sql`${t.state} <> 'promoted' OR ${t.promotedLineage} IS NOT NULL`,
    ),
    useCountCheck: check(
      "memories_use_count_check",
      sql`${t.useCount} >= 0`,
    ),
    labelCheck: check(
      "memories_label_check",
      sql`(${t.label} IS NULL OR char_length(${t.label}) BETWEEN 1 AND 200) AND (${t.summary} IS NULL OR char_length(${t.summary}) BETWEEN 1 AND 1000) AND (${t.memoryType} IS NULL OR ${t.memoryType} ~ '^[a-z][a-z0-9_-]{0,31}$')`,
    ),
    // memory/v1 pairs agent and run with capture: remember sets both, a
    // local_gateway memory has no run, a pull_request memory has either.
    pairingCheck: check(
      "memories_capture_pairing_check",
      sql`(${t.capture} <> 'remember' OR (${t.runPublicId} IS NOT NULL AND ${t.agentLineage} IS NOT NULL)) AND (${t.capture} <> 'local_gateway' OR ${t.runPublicId} IS NULL)`,
    ),
    runCheck: check(
      "memories_run_public_id_check",
      sql`${t.runPublicId} IS NULL OR ${t.runPublicId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    statementCheck: check(
      "memories_statement_check",
      sql`${t.statement} <> '' AND char_length(${t.statement}) <= 2000`,
    ),
  }),
);

// One row per memory, run, and signal (ADR-245). `read` is a run that read
// the memory's file, `harness_count` is a use the harness counted itself with
// no run, and `citation` is a run that cited the memory. `count` is how many
// times: reads in that run, or the harness's count. A memory's `use_count` is
// its distinct runs plus the `count` of its uses with no run.
export const memoryUses = agentSchema.table(
  "memory_uses",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    runPublicId: text("run_public_id"),
    signal: text("signal").notNull(),
    count: integer("count").notNull().default(1),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    useUniq: unique("memory_uses_uq")
      .on(t.memoryId, t.runPublicId, t.signal)
      .nullsNotDistinct(),
    memoryIdx: index("memory_uses_memory_idx").on(t.memoryId, t.usedAt),
    runCheck: check(
      "memory_uses_run_public_id_check",
      sql`${t.runPublicId} IS NULL OR ${t.runPublicId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    signalCheck: check(
      "memory_uses_signal_check",
      sql`${t.signal} IN ('read', 'harness_count', 'citation')`,
    ),
    // Only a harness's own count can have no run.
    pairingCheck: check(
      "memory_uses_signal_run_check",
      sql`${t.signal} = 'harness_count' OR ${t.runPublicId} IS NOT NULL`,
    ),
    countCheck: check("memory_uses_count_check", sql`${t.count} >= 1`),
  }),
);

export const memoryRejections = agentSchema.table(
  "memory_rejections",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    statementHash: text("statement_hash").notNull(),
    memoryPrId: uuid("memory_pr_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    hashUniq: uniqueIndex("memory_rejections_hash_uq").on(
      t.workspaceId,
      t.statementHash,
    ),
  }),
);

export const memoryRecalls = agentSchema.table(
  "memory_recalls",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    lineage: text("lineage").notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    // When a person last decided on the record: its memory PR merged, or a
    // proposal to retire it merged or closed. A contradiction counts only
    // lessons written after it.
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    lineageUniq: uniqueIndex("memory_recalls_lineage_uq").on(
      t.workspaceId,
      t.lineage,
    ),
  }),
);
