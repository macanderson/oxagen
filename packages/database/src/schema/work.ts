// The work schema (C0, #4735): work items, the collectors that bring them in,
// triage, done records, and autonomy.
//
// agent-work-spec.html, Storage, names these ten tables and their key
// columns. Every table carries the org mixin and the same row-level security
// as the rest of the database (migration 20260929000000_work_schema.sql).
// work.done_verdicts and work.autonomy_events are append only: the migration
// revokes UPDATE and DELETE from oxagen_app on both. work.items is soft
// deleted: it carries deleted_at and deleted_by_id, and oxagen_app has no
// DELETE on it. A soft-deleted item keeps its number and its provider key, so
// a collector that hears from the same provider item finds the deleted row.
//
// A column named `by` holds who acted: a user id, or the name of the Oxagen
// step that acted (`triage`, `oxagen`).
//
// work.items.triage_id points at work.triage_decisions, and
// work.triage_decisions.item_id points back at work.items. Only item_id
// carries a foreign key. triage_id is indexed, and the triage writer sets it
// after it stores the decision.
//
// Work orders and tasks.work_order_bindings stay as work-in-flight-spec.md §9
// names them. No tasks schema exists yet, so this file declares neither.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  appendOnlyAuditMixin,
  auditMixin,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";
import { workSchema } from "./_schemas";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// The value lists below back this file's check constraints. @oxagen/work and
// @oxagen/done-record declare the same lists (COLLECTOR_TYPES,
// COLLECTOR_HEALTH, PRIORITY_LABELS, DONE_VERDICTS, AUTONOMY_CAUSES, and the
// rest), and @oxagen/ingestion repeats the collector types as CollectorType.
// This package depends on none of them, so a change to one list changes every
// copy.

/** The collector types (agent-work-spec.html, Collectors). */
export const WORK_COLLECTOR_TYPES = [
  "github",
  "jira",
  "linear",
  "zendesk",
  "servicenow",
  "salesforce",
  "slack",
  "email",
] as const;

/** A collector's health (agent-work-spec.html, Collectors). */
export const WORK_COLLECTOR_HEALTH = [
  "healthy",
  "lagging",
  "failing",
  "paused",
] as const;

/** Where a work item came from. */
export const WORK_ITEM_ORIGINS = [
  "provider",
  "email",
  "slack",
  "csv",
  "manual",
] as const;

/** Where a work item is in agent work. It replaces readiness. */
export const WORK_ITEM_STATES = [
  "new",
  "held",
  "triaged",
  "needs_info",
  "changed",
  "ready",
  "sent",
  "done",
  "closed",
] as const;

/** The Priority labels (tasks-spec.md §6.4). */
export const WORK_PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;

/** A status's category (tasks-spec.md §6.2). */
export const WORK_STATUS_CATEGORIES = ["open", "blocked", "closed"] as const;

/** How one work item relates to another. */
export const WORK_LINK_KINDS = [
  "blocks",
  "duplicates",
  "related",
  "caused_by",
] as const;

/** A done record's verdict. */
export const WORK_VERDICTS = ["pending", "held", "proven", "broken"] as const;

/** Why a done record is not held or proven. */
export const WORK_VERDICT_REASONS = [
  "CHECK_FAILED",
  "TOOL_DENIED",
  "BUDGET_EXCEEDED",
  "ATTEMPTS_EXHAUSTED",
  "LOCK_MISMATCH",
  "EVIDENCE_INVALID",
  "HUMAN_PENDING",
  "HARNESS_ERROR",
] as const;

/** What changed an autonomy level. */
export const WORK_AUTONOMY_CAUSES = [
  "steering_pr",
  "revert",
  "escaped_defect",
  "sample_rejected",
] as const;

/** A collector, mirrored from its file at work/collectors/<name>.toml. */
export const workCollectors = workSchema.table(
  "collectors",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...auditMixin(),
    /** The file's name without `.toml`. */
    name: text("name").notNull(),
    type: text("type").notNull(),
    /** The provider connection. Email has none. */
    connectionId: uuid("connection_id"),
    /** The file's [scope] table (collector/v1). */
    scope: jsonb("scope")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    health: text("health").notNull().default("healthy"),
    /** Where the next reconcile starts reading. */
    cursor: text("cursor"),
    /** The SHA-256 of the file this row mirrors. */
    fileHash: text("file_hash").notNull(),
  },
  (t) => ({
    nameUniq: uniqueIndex("collectors_name_uniq").on(
      t.orgId,
      t.workspaceId,
      t.name,
    ),
    typeCheck: check(
      "collectors_type_check",
      sql`${t.type} IN ('github', 'jira', 'linear', 'zendesk', 'servicenow', 'salesforce', 'slack', 'email')`,
    ),
    healthCheck: check(
      "collectors_health_check",
      sql`${t.health} IN ('healthy', 'lagging', 'failing', 'paused')`,
    ),
  }),
);

/** An event a collector heard, stored before any mapping. */
export const workInboundEvents = workSchema.table(
  "inbound_events",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => workCollectors.id),
    /** The provider's delivery id. A repeat delivery is a no-op. */
    deliveryId: text("delivery_id").notNull(),
    /** The body in a CloudEvents envelope. */
    cloudevent: jsonb("cloudevent").$type<Record<string, unknown>>().notNull(),
    /** The object storage key of the raw body, keyed by SHA-256. */
    rawRef: text("raw_ref"),
    processedAt: ts("processed_at"),
    /** What processing did with the event. */
    outcome: text("outcome"),
  },
  (t) => ({
    deliveryUniq: uniqueIndex("inbound_events_delivery_uniq").on(
      t.collectorId,
      t.deliveryId,
    ),
    unprocessedIdx: index("inbound_events_unprocessed_idx")
      .on(t.collectorId, t.createdAt)
      .where(sql`${t.processedAt} IS NULL`),
  }),
);

/**
 * A work item: one unit of work, whatever its source called it. It keeps the
 * seventeen fields of tasks-spec.md §6.1 and work-in-flight-spec.md §4. The
 * provider's own created and updated fields carry a `source_` prefix, so they
 * stay apart from Oxagen's audit columns.
 */
export const workItems = workSchema.table(
  "items",
  {
    ...idMixin("wi"),
    ...orgScopeMixin(),
    ...auditMixin(),
    ...softDeleteMixin(),
    /** The per-workspace number people say out loud, such as `OPS-88`. */
    number: text("number").notNull(),
    subject: text("subject").notNull(),
    description: text("description"),
    labels: text("labels").array().notNull().default(sql`'{}'`),
    owner: text("owner"),
    sourceCreatedBy: text("source_created_by"),
    sourceCreatedAt: ts("source_created_at"),
    sourceUpdatedBy: text("source_updated_by"),
    sourceUpdatedAt: ts("source_updated_at"),
    closedAt: ts("closed_at"),
    status: text("status").notNull().default("Open"),
    statusCategory: text("status_category").notNull().default("open"),
    resolution: text("resolution"),
    /** The key Oxagen matches on. It never changes for the life of the item. */
    providerId: text("provider_id"),
    sourceUrl: text("source_url"),
    /** The highest-ranked Priority label, such as `P1`. None when absent. */
    priority: text("priority"),
    /** The provider value the Priority label came from. */
    priorityRaw: text("priority_raw"),
    estimateMinutes: integer("estimate_minutes"),
    /** A person's override from set_task_priority: the label, who, and why. */
    planningPriority: jsonb("planning_priority").$type<{
      label: (typeof WORK_PRIORITY_LABELS)[number];
      by: string;
      why: string;
      at: string;
    }>(),
    /** None for a work item a person made in Oxagen. */
    collectorId: uuid("collector_id").references(() => workCollectors.id),
    origin: text("origin").notNull(),
    /** The name and address the source gave. Never mapped to a user. */
    requester: text("requester"),
    /** The fields that came from outside the workspace. */
    tainted: text("tainted").array().notNull().default(sql`'{}'`),
    state: text("state").notNull().default("new"),
    heldReason: text("held_reason"),
    /** The current triage decision. See the file comment. */
    triageId: uuid("triage_id"),
    doneRecordDigest: text("done_record_digest"),
    duplicateOf: uuid("duplicate_of"),
    levelAtSend: smallint("level_at_send"),
  },
  (t) => ({
    numberUniq: uniqueIndex("items_number_uniq").on(
      t.orgId,
      t.workspaceId,
      t.number,
    ),
    providerUniq: uniqueIndex("items_provider_uniq")
      .on(t.collectorId, t.providerId)
      .where(sql`${t.providerId} IS NOT NULL`),
    stateIdx: index("items_state_idx").on(t.orgId, t.workspaceId, t.state),
    triageIdx: index("items_triage_idx").on(t.triageId),
    duplicateOfFk: foreignKey({
      name: "items_duplicate_of_fk",
      columns: [t.duplicateOf],
      foreignColumns: [t.id],
    }),
    originCheck: check(
      "items_origin_check",
      sql`${t.origin} IN ('provider', 'email', 'slack', 'csv', 'manual')`,
    ),
    stateCheck: check(
      "items_state_check",
      sql`${t.state} IN ('new', 'held', 'triaged', 'needs_info', 'changed', 'ready', 'sent', 'done', 'closed')`,
    ),
    statusCategoryCheck: check(
      "items_status_category_check",
      sql`${t.statusCategory} IN ('open', 'blocked', 'closed')`,
    ),
    estimateCheck: check(
      "items_estimate_check",
      sql`${t.estimateMinutes} IS NULL OR ${t.estimateMinutes} >= 0`,
    ),
    priorityCheck: check(
      "items_priority_check",
      sql`${t.priority} IS NULL OR ${t.priority} IN ('P0', 'P1', 'P2', 'P3')`,
    ),
    planningPriorityCheck: check(
      "items_planning_priority_check",
      sql`${t.planningPriority} IS NULL OR COALESCE(${t.planningPriority}->>'label', '') IN ('P0', 'P1', 'P2', 'P3')`,
    ),
    levelCheck: check(
      "items_level_at_send_check",
      sql`${t.levelAtSend} IS NULL OR ${t.levelAtSend} BETWEEN 0 AND 3`,
    ),
    digestCheck: check(
      "items_done_record_digest_check",
      sql`${t.doneRecordDigest} IS NULL OR ${t.doneRecordDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

/** A link between two work items. */
export const workItemLinks = workSchema.table(
  "item_links",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    fromId: uuid("from_id")
      .notNull()
      .references(() => workItems.id),
    toId: uuid("to_id")
      .notNull()
      .references(() => workItems.id),
    kind: text("kind").notNull(),
    by: text("by").notNull(),
  },
  (t) => ({
    linkUniq: uniqueIndex("item_links_uniq").on(t.fromId, t.toId, t.kind),
    toIdx: index("item_links_to_idx").on(t.toId),
    kindCheck: check(
      "item_links_kind_check",
      sql`${t.kind} IN ('blocks', 'duplicates', 'related', 'caused_by')`,
    ),
    selfCheck: check("item_links_self_check", sql`${t.fromId} <> ${t.toId}`),
  }),
);

/**
 * A triage decision. `output` holds a triage/v1 document. The public id
 * (`tri_...`) is what a done record's `drafted_by.decision` names.
 */
export const workTriageDecisions = workSchema.table(
  "triage_decisions",
  {
    ...idMixin("tri"),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => workItems.id),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    model: text("model").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    /** The SHA-256 of the priorities record triage read. */
    prioritiesHash: text("priorities_hash").notNull(),
    inputDigest: text("input_digest").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
  },
  (t) => ({
    itemIdx: index("triage_decisions_item_idx").on(t.itemId, t.createdAt),
    costCheck: check("triage_decisions_cost_check", sql`${t.costUsd} >= 0`),
  }),
);

/** A field a person changed on a triage decision. */
export const workTriageCorrections = workSchema.table(
  "triage_corrections",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => workTriageDecisions.id),
    field: text("field").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    by: text("by").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => ({
    decisionIdx: index("triage_corrections_decision_idx").on(t.decisionId),
  }),
);

/** A locked done record. `body` holds a done-record/v1 document. */
export const workDoneRecords = workSchema.table(
  "done_records",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** lockDigest of the body: `sha256:` and 64 hex characters. */
    digest: text("digest").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => workItems.id),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    draftedByModel: text("drafted_by_model"),
    lockedBy: text("locked_by").notNull(),
    lockedAt: ts("locked_at").notNull(),
  },
  (t) => ({
    digestUniq: uniqueIndex("done_records_digest_uniq").on(
      t.orgId,
      t.workspaceId,
      t.digest,
    ),
    itemIdx: index("done_records_item_idx").on(t.itemId),
    digestCheck: check(
      "done_records_digest_check",
      sql`${t.digest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

/** A done record's verdict change. Append only. */
export const workDoneVerdicts = workSchema.table(
  "done_verdicts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    recordDigest: text("record_digest").notNull(),
    verdict: text("verdict").notNull(),
    reasons: text("reasons").array().notNull().default(sql`'{}'`),
    /** Each criterion's id and state when the verdict changed. */
    criteria: jsonb("criteria")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The model each stage ran, by role. */
    stageModels: jsonb("stage_models")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attestationRef: text("attestation_ref"),
    commitSha: text("commit_sha"),
  },
  (t) => ({
    recordIdx: index("done_verdicts_record_idx").on(
      t.orgId,
      t.workspaceId,
      t.recordDigest,
      t.createdAt,
    ),
    verdictCheck: check(
      "done_verdicts_verdict_check",
      sql`${t.verdict} IN ('pending', 'held', 'proven', 'broken')`,
    ),
    reasonsCheck: check(
      "done_verdicts_reasons_check",
      sql`${t.reasons} <@ ARRAY['CHECK_FAILED', 'TOOL_DENIED', 'BUDGET_EXCEEDED', 'ATTEMPTS_EXHAUSTED', 'LOCK_MISMATCH', 'EVIDENCE_INVALID', 'HUMAN_PENDING', 'HARNESS_ERROR']::text[]`,
    ),
    digestCheck: check(
      "done_verdicts_record_digest_check",
      sql`${t.recordDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

/** An autonomy level change. Append only. */
export const workAutonomyEvents = workSchema.table(
  "autonomy_events",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    /** The [[autonomy]] scope: `{ label }`, or `{ repo, paths }`. */
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
    /** None for the first level a scope gets. */
    fromLevel: smallint("from_level"),
    toLevel: smallint("to_level").notNull(),
    cause: text("cause").notNull(),
    by: text("by").notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => ({
    createdIdx: index("autonomy_events_created_idx").on(
      t.orgId,
      t.workspaceId,
      t.createdAt,
    ),
    fromLevelCheck: check(
      "autonomy_events_from_level_check",
      sql`${t.fromLevel} IS NULL OR ${t.fromLevel} BETWEEN 0 AND 3`,
    ),
    toLevelCheck: check(
      "autonomy_events_to_level_check",
      sql`${t.toLevel} BETWEEN 0 AND 3`,
    ),
    causeCheck: check(
      "autonomy_events_cause_check",
      sql`${t.cause} IN ('steering_pr', 'revert', 'escaped_defect', 'sample_rejected')`,
    ),
  }),
);

/** An export of training examples. */
export const workTrainingExports = workSchema.table(
  "training_exports",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    /** The SHA-256 of the [training] consent the export ran under. */
    consentHash: text("consent_hash").notNull(),
    count: integer("count").notNull(),
    positive: integer("positive").notNull(),
    negative: integer("negative").notNull(),
    /** The object storage key of the JSON Lines file. None once deleted. */
    objectRef: text("object_ref"),
    digest: text("digest").notNull(),
    deletedAt: ts("deleted_at"),
  },
  (t) => ({
    createdIdx: index("training_exports_created_idx").on(
      t.orgId,
      t.workspaceId,
      t.createdAt,
    ),
    countsCheck: check(
      "training_exports_counts_check",
      sql`${t.count} >= 0 AND ${t.positive} >= 0 AND ${t.negative} >= 0 AND ${t.positive} + ${t.negative} <= ${t.count}`,
    ),
  }),
);
