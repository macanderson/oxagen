// The work schema: work items, the collectors that bring them in, triage, the
// Phase 1 work records, done records, and autonomy.
//
// C0 (#4735, migration 20260929000000_work_schema.sql) created ten tables from
// agent-work-spec.html, Storage. P1-02 (#4897, migration
// 20261002030300_work_records.sql) adds the Phase 1 work records from
// agent-work-phase-1.html, Data contract: a revision and a version on each
// work item, the acceptance brief (work.briefs), the work order
// (work.orders), and the append-only history (work.item_facts). ADR-244 maps
// each Phase 1 object to these tables. F13 (#4638, migration
// 20261002063000_work_direct_orders.sql) adds the direct work order of a run
// no send covers (work.direct_orders) and each check run of a definition of
// done (work.done_checks). R3 (#5108, migration
// 20261002140000_work_send_backs.sql) adds the send-back notes Oxagen posted
// (work.send_backs). Every table carries the org mixin and the same
// row-level security as the rest of the database.
//
// Append only: work.briefs, work.item_facts, work.triage_decisions,
// work.triage_corrections, work.done_verdicts, work.done_checks,
// work.send_backs, and work.autonomy_events. The
// migrations revoke UPDATE and DELETE from oxagen_app on each, and a trigger
// refuses any UPDATE of a brief, a fact, a check run, or a send-back note. work.items is soft deleted: it
// carries deleted_at and deleted_by_id, and oxagen_app has no DELETE on it. A
// soft-deleted item keeps its number and its provider key, so a collector that
// hears from the same provider item finds the deleted row.
//
// A column named `by`, `author`, or `actor` holds who acted: a user id, a
// runtime's public id, or the name of the Oxagen step that acted (`triage`,
// `oxagen`).
//
// work.items.triage_id points at work.triage_decisions, and
// work.triage_decisions.item_id points back at work.items. Only item_id
// carries a foreign key. triage_id is indexed, and the triage writer sets it
// after it stores the decision.
//
// A work order names its target agent, runtime, operator, and mandate by id
// with no foreign key, because those rows live in other schemas (agent.*,
// tools.*). The store that writes an order checks them.
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

/**
 * Where a work item is in agent work. It replaces readiness. The state is a
 * projection of the item's facts: @oxagen/work's reduceWorkItem computes it,
 * and only the work record store writes it. WORK_ITEM_STATES in @oxagen/work
 * repeats this list. Change both together.
 */
export const WORK_ITEM_STATES = [
  "new",
  "held",
  "triaged",
  "needs_info",
  "changed",
  "ready",
  "sent",
  "running",
  "review",
  "done",
  "closed",
] as const;

/** The kinds of fact work.item_facts records. FACT_KINDS in @oxagen/work repeats this list. */
export const WORK_FACT_KINDS = [
  "collected",
  "entered",
  "source_changed",
  "triage_recorded",
  "triage_failed",
  "triage_overridden",
  "brief_saved",
  "brief_approved",
  "closed",
  "reopened",
  "send_requested",
  "send_delivered",
  "send_rejected",
  "send_withdrawn",
  "claimed",
  "run_linked",
  "run_ended",
  "stop_requested",
  "stopped",
  "pr_linked",
  "head_observed",
  "checks_required",
  "check_observed",
  "criterion_claimed",
  "returned",
  "accepted",
  "merged",
  "pr_closed",
] as const;

/** The fact kinds that belong to a work order. ORDER_FACT_KINDS in @oxagen/work repeats this list. */
export const WORK_ORDER_FACT_KINDS = [
  "send_requested",
  "send_delivered",
  "send_rejected",
  "send_withdrawn",
  "claimed",
  "run_linked",
  "run_ended",
  "stop_requested",
  "stopped",
  "pr_linked",
  "head_observed",
  "checks_required",
  "check_observed",
  "criterion_claimed",
  "returned",
  "accepted",
  "merged",
  "pr_closed",
] as const;

/** Who reported a fact. FACT_SOURCES in @oxagen/work repeats this list. */
export const WORK_FACT_SOURCES = ["provider", "runtime", "agent", "person", "oxagen"] as const;

/** A runtime's enforcement tier at send. RUNTIME_TIERS in @oxagen/work repeats this list. */
export const WORK_RUNTIME_TIERS = ["contained", "gateway", "harness", "observe"] as const;

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
    /** The repository the item came from, as owner/name. Null for an item a person entered. */
    sourceRepository: text("source_repository"),
    /**
     * The digest of the subject, description, and labels at the current
     * revision (@oxagen/work sourceDigest). A comment, an assignee, or a status
     * change leaves it alone.
     */
    sourceDigest: text("source_digest"),
    /**
     * The item revision. It moves on a material source change, a brief change
     * after approval, and a reopen, and never goes back.
     */
    materialRevision: integer("material_revision").notNull().default(1),
    /**
     * The concurrency token. Every write through the work record store moves
     * it by one, and an action that names an older value is refused.
     */
    version: integer("version").notNull().default(0),
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
    // One source item is one work item in a workspace, whichever collector
    // heard it. A provider id is unique across the workspace's connections:
    // GitHub's is the issue's node id, which survives a repository rename.
    // Soft-deleted rows keep their key, so a repeat finds the deleted row.
    sourceUniq: uniqueIndex("items_source_uniq")
      .on(t.orgId, t.workspaceId, t.providerId)
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
      sql`${t.state} IN ('new', 'held', 'triaged', 'needs_info', 'changed', 'ready', 'sent', 'running', 'review', 'done', 'closed')`,
    ),
    sourceDigestCheck: check(
      "items_source_digest_check",
      sql`${t.sourceDigest} IS NULL OR ${t.sourceDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    materialRevisionCheck: check(
      "items_material_revision_check",
      sql`${t.materialRevision} >= 1`,
    ),
    versionCheck: check("items_version_check", sql`${t.version} >= 0`),
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
    /** The model the gateway recorded. Null when nothing recorded it: unknown stays unknown. */
    model: text("model"),
    promptDigest: text("prompt_digest").notNull(),
    /** The SHA-256 of the priorities record triage read. */
    prioritiesHash: text("priorities_hash").notNull(),
    inputDigest: text("input_digest").notNull(),
    /** What the decision cost. Null when the cost is unknown, never 0 in its place. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    /** The work item revision triage read. */
    itemRevision: integer("item_revision"),
  },
  (t) => ({
    itemIdx: index("triage_decisions_item_idx").on(t.itemId, t.createdAt),
    costCheck: check("triage_decisions_cost_check", sql`${t.costUsd} >= 0`),
    itemRevisionCheck: check(
      "triage_decisions_item_revision_check",
      sql`${t.itemRevision} IS NULL OR ${t.itemRevision} >= 1`,
    ),
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

/**
 * One revision of a work item's acceptance brief. `body` holds a
 * work-brief/v1 document and `digest` is its RFC 8785 SHA-256. A row never
 * changes: an edit is a new revision, and an approval is a brief_approved fact
 * that names the digest. `item_revision` is the item revision the brief was
 * written against.
 */
export const workBriefs = workSchema.table(
  "briefs",
  {
    ...idMixin("brf"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => workItems.id),
    /** 1, 2, 3 per item. */
    revision: integer("revision").notNull(),
    itemRevision: integer("item_revision").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    digest: text("digest").notNull(),
    /** Who wrote the revision: a user id, or `triage`. */
    author: text("author").notNull(),
  },
  (t) => ({
    revisionUniq: uniqueIndex("briefs_item_revision_uniq").on(
      t.itemId,
      t.revision,
    ),
    // The targets of the work order's and the fact's composite foreign keys,
    // so neither can name a digest or revision the brief does not have.
    digestKey: uniqueIndex("briefs_item_digest_key").on(
      t.id,
      t.itemId,
      t.digest,
    ),
    revisionKey: uniqueIndex("briefs_item_revision_key").on(
      t.id,
      t.itemId,
      t.revision,
      t.digest,
    ),
    revisionCheck: check("briefs_revision_check", sql`${t.revision} >= 1`),
    itemRevisionCheck: check(
      "briefs_item_revision_check",
      sql`${t.itemRevision} >= 1`,
    ),
    digestCheck: check(
      "briefs_digest_check",
      sql`${t.digest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

/**
 * A work order: one send of one approved brief revision to one agent on one
 * runtime. The send facts never change. `released_at` frees the agent for its
 * next work order (the run ended or the send is over), and `closed_at` ends
 * the send so the item may be sent again. Each moves once, from null.
 */
export const workOrders = workSchema.table(
  "orders",
  {
    ...idMixin("wo"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => workItems.id),
    /** The item revision the send went out on. */
    itemRevision: integer("item_revision").notNull(),
    /** 1, 2, 3 per item. */
    send: integer("send").notNull(),
    briefId: uuid("brief_id").notNull(),
    briefRevision: integer("brief_revision").notNull(),
    briefDigest: text("brief_digest").notNull(),
    /** `<item>:r<brief revision>:s<send>`, fixed before the send leaves. A retry reuses it. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** agent.agents.id. */
    agentId: uuid("agent_id").notNull(),
    /** agent.runtimes.id. */
    runtimeId: uuid("runtime_id").notNull(),
    /** The runtime's enforcement tier at send, which says where the budget is enforced. */
    runtimeTier: text("runtime_tier").notNull(),
    /** The person who sent it. */
    operatorId: uuid("operator_id").notNull(),
    /** tools.mandates.id of the agent's mandate at send. */
    mandateId: uuid("mandate_id"),
    /** The repository the work changes, as owner/name. */
    repository: text("repository").notNull(),
    /** A budget reservation for the send, where the runtime's tier supports one. */
    budgetReservationId: uuid("budget_reservation_id"),
    releasedAt: ts("released_at"),
    closedAt: ts("closed_at"),
  },
  (t) => ({
    keyUniq: uniqueIndex("orders_key_uniq").on(
      t.orgId,
      t.workspaceId,
      t.idempotencyKey,
    ),
    sendUniq: uniqueIndex("orders_item_send_uniq").on(t.itemId, t.send),
    // One open send per work item, and one unreleased send per agent: the
    // atomic capacity claim. A second insert fails on the index.
    openItemUniq: uniqueIndex("orders_open_item_uniq")
      .on(t.itemId)
      .where(sql`${t.closedAt} IS NULL`),
    openAgentUniq: uniqueIndex("orders_open_agent_uniq")
      .on(t.orgId, t.workspaceId, t.agentId)
      .where(sql`${t.releasedAt} IS NULL`),
    itemKey: uniqueIndex("orders_item_key").on(t.id, t.itemId),
    briefFk: foreignKey({
      name: "orders_brief_fk",
      columns: [t.briefId, t.itemId, t.briefRevision, t.briefDigest],
      foreignColumns: [
        workBriefs.id,
        workBriefs.itemId,
        workBriefs.revision,
        workBriefs.digest,
      ],
    }),
    sendCheck: check("orders_send_check", sql`${t.send} >= 1`),
    itemRevisionCheck: check(
      "orders_item_revision_check",
      sql`${t.itemRevision} >= 1`,
    ),
    runtimeTierCheck: check(
      "orders_runtime_tier_check",
      sql`${t.runtimeTier} IN ('contained', 'gateway', 'harness', 'observe')`,
    ),
    closedAfterReleaseCheck: check(
      "orders_closed_released_check",
      sql`${t.closedAt} IS NULL OR ${t.releasedAt} IS NOT NULL`,
    ),
  }),
);

/** What a run's work order is: a send (work.orders) or a direct work order (work.direct_orders). */
export const WORK_ORDER_KINDS = ["send", "direct"] as const;

/**
 * A direct work order: the parent work order of one run that no send covers,
 * such as a run an operator started outside Oxagen (wasted-spend.html,
 * Operator productivity, Unassigned spend; F13, #4638). A send needs a work
 * item and an approved brief, so a direct work order cannot live in
 * work.orders. The spend rollup opens one the first time it rolls up such a
 * run.
 *
 * What it covers never changes. A person can attach it to a work item later:
 * `item_id`, `attached_at`, and `attached_by` move together, once, from null,
 * and a trigger refuses a work item from another org or workspace. Spend on a
 * direct work order with no work item is unassigned spend.
 */
export const workDirectOrders = workSchema.table(
  "direct_orders",
  {
    ...idMixin("dwo"),
    ...orgScopeMixin(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** The run it covers: `arun_…` or `tse_…`, as cost.run_totals.run_id names it. */
    runId: text("run_id").notNull(),
    /** The run's operator, as cost.run_totals.operator_principal_id names it. */
    operatorPrincipalId: uuid("operator_principal_id"),
    /** The run's agent, as cost.run_totals.agent_principal_id names it. */
    agentPrincipalId: uuid("agent_principal_id"),
    /** When the run started. */
    openedAt: ts("opened_at").notNull(),
    /** The work item a person attached it to. None while it is unassigned. */
    itemId: uuid("item_id").references(() => workItems.id),
    attachedAt: ts("attached_at"),
    /** The user id of the person who attached it. */
    attachedBy: text("attached_by"),
  },
  (t) => ({
    runUniq: uniqueIndex("direct_orders_run_uniq").on(t.runId),
    openedIdx: index("direct_orders_opened_idx").on(
      t.orgId,
      t.workspaceId,
      t.openedAt,
    ),
    itemIdx: index("direct_orders_item_idx")
      .on(t.itemId)
      .where(sql`${t.itemId} IS NOT NULL`),
    runIdCheck: check(
      "direct_orders_run_id_check",
      sql`${t.runId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    attachedCheck: check(
      "direct_orders_attached_check",
      sql`(${t.itemId} IS NULL) = (${t.attachedAt} IS NULL) AND (${t.itemId} IS NULL) = (${t.attachedBy} IS NULL)`,
    ),
  }),
);

/**
 * One fact in a work item's history. Append only: a row never changes, and a
 * fact whose dedupe key the item already holds is a repeat. The item's state is
 * a projection of these rows (@oxagen/work reduceWorkItem). `occurred_at` is
 * when it happened, the provider's own time where it has one, and `created_at`
 * is when Oxagen recorded it.
 */
export const workItemFacts = workSchema.table(
  "item_facts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => workItems.id),
    /** Set on every order fact and on no item fact. */
    orderId: uuid("order_id"),
    kind: text("kind").notNull(),
    /** Who reported it: provider, runtime, agent, person, or oxagen. */
    source: text("source").notNull(),
    /** The item revision it belongs to. An order's facts carry the revision the order went out on. */
    itemRevision: integer("item_revision").notNull(),
    briefId: uuid("brief_id"),
    briefDigest: text("brief_digest"),
    repository: text("repository"),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    runId: text("run_id"),
    criterionId: text("criterion_id"),
    actor: text("actor").notNull(),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: ts("occurred_at").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
  },
  (t) => ({
    dedupeUniq: uniqueIndex("item_facts_dedupe_uniq").on(
      t.itemId,
      t.dedupeKey,
    ),
    itemIdx: index("item_facts_item_idx").on(
      t.itemId,
      t.itemRevision,
      t.occurredAt,
    ),
    orderIdx: index("item_facts_order_idx")
      .on(t.orderId)
      .where(sql`${t.orderId} IS NOT NULL`),
    // The spend rollup finds the send a run belongs to by its run_linked
    // fact (F13, #4638).
    runLinkedIdx: index("item_facts_run_linked_idx")
      .on(t.runId)
      .where(sql`${t.kind} = 'run_linked'`),
    // A GitHub pull_request delivery finds the send that ran the pull request
    // by its pr_linked fact (P1-04, #5100).
    prLinkedIdx: index("item_facts_pr_linked_idx")
      .on(t.orgId, t.workspaceId, t.repository, t.prNumber)
      .where(sql`${t.kind} = 'pr_linked'`),
    // One approved brief per item revision, and one send request per order.
    approvalUniq: uniqueIndex("item_facts_approval_uniq")
      .on(t.itemId, t.itemRevision)
      .where(sql`${t.kind} = 'brief_approved'`),
    sendUniq: uniqueIndex("item_facts_send_uniq")
      .on(t.orderId)
      .where(sql`${t.kind} = 'send_requested'`),
    orderFk: foreignKey({
      name: "item_facts_order_fk",
      columns: [t.orderId, t.itemId],
      foreignColumns: [workOrders.id, workOrders.itemId],
    }),
    briefFk: foreignKey({
      name: "item_facts_brief_fk",
      columns: [t.briefId, t.itemId, t.briefDigest],
      foreignColumns: [workBriefs.id, workBriefs.itemId, workBriefs.digest],
    }),
    kindCheck: check(
      "item_facts_kind_check",
      sql`${t.kind} IN ('collected', 'entered', 'source_changed', 'triage_recorded', 'triage_failed', 'triage_overridden', 'brief_saved', 'brief_approved', 'closed', 'reopened', 'send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed')`,
    ),
    sourceCheck: check(
      "item_facts_source_check",
      sql`${t.source} IN ('provider', 'runtime', 'agent', 'person', 'oxagen')`,
    ),
    orderCheck: check(
      "item_facts_order_check",
      sql`(${t.kind} IN ('send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed')) = (${t.orderId} IS NOT NULL)`,
    ),
    briefCheck: check(
      "item_facts_brief_check",
      sql`(${t.briefId} IS NULL) = (${t.briefDigest} IS NULL)`,
    ),
    itemRevisionCheck: check(
      "item_facts_item_revision_check",
      sql`${t.itemRevision} >= 1`,
    ),
    headShaCheck: check(
      "item_facts_head_sha_check",
      sql`${t.headSha} IS NULL OR ${t.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    runIdCheck: check(
      "item_facts_run_id_check",
      sql`${t.runId} IS NULL OR ${t.runId} ~ '^(arun|tse)_[0-9a-z]+$'`,
    ),
    prNumberCheck: check(
      "item_facts_pr_number_check",
      sql`${t.prNumber} IS NULL OR ${t.prNumber} >= 1`,
    ),
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

/** A check run's result: held and proven pass, broken fails, and pending has not decided. */
export const WORK_DONE_CHECK_RESULTS = ["passed", "failed", "pending"] as const;

/**
 * One check run of a definition of done: one decide over a work order's done
 * record, written each time a stage of the work order finishes, whether or not
 * the verdict changed (F13, #4638). work.done_verdicts keeps only the changes.
 * Append only. One row per work order and stage session, so a retried step
 * writes none.
 */
export const workDoneChecks = workSchema.table(
  "done_checks",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => workOrders.id),
    /** The done record's lock digest. */
    recordDigest: text("record_digest").notNull(),
    verdict: text("verdict").notNull(),
    /** `passed` for held or proven, `failed` for broken, `pending` otherwise. */
    result: text("result").notNull(),
    checkedAt: ts("checked_at").notNull(),
    /** The session of the stage whose end ran the check. */
    sessionId: text("session_id").notNull(),
    /** That stage's role in its workflow file, such as `Fix`. */
    role: text("role").notNull(),
  },
  (t) => ({
    sessionUniq: uniqueIndex("done_checks_session_uniq").on(
      t.orderId,
      t.sessionId,
    ),
    checkedIdx: index("done_checks_checked_idx").on(
      t.orgId,
      t.workspaceId,
      t.checkedAt,
    ),
    digestCheck: check(
      "done_checks_record_digest_check",
      sql`${t.recordDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    verdictCheck: check(
      "done_checks_verdict_check",
      sql`${t.verdict} IN ('pending', 'held', 'proven', 'broken')`,
    ),
    resultCheck: check(
      "done_checks_result_check",
      sql`${t.result} = CASE ${t.verdict} WHEN 'held' THEN 'passed' WHEN 'proven' THEN 'passed' WHEN 'broken' THEN 'failed' ELSE 'pending' END`,
    ),
  }),
);

/**
 * One send-back note Oxagen posted on a work item (R3, #5108). A work order
 * goes back to its work item when its last runs each ended with nothing kept
 * (F34, #5085). A streak is the work order and the newest run in it, so one
 * row per streak keeps a later pass from posting the same note again, and a
 * new run starts a new streak. A row is written only once the note is
 * written. Append only.
 */
export const workSendBacks = workSchema.table(
  "send_backs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => workOrders.id),
    /** The newest run of the streak the note named: `arun_…` or `tse_…`. */
    lastRunId: text("last_run_id").notNull(),
  },
  (t) => ({
    streakUniq: uniqueIndex("send_backs_streak_uniq").on(
      t.orderId,
      t.lastRunId,
    ),
    createdIdx: index("send_backs_created_idx").on(
      t.orgId,
      t.workspaceId,
      t.createdAt,
    ),
    lastRunIdCheck: check(
      "send_backs_last_run_id_check",
      sql`${t.lastRunId} ~ '^(arun|tse)_[0-9a-z]+$'`,
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
