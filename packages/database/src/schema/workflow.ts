import {
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
import { sql } from "drizzle-orm";
import { workflowSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";

// ---------------------------------------------------------------------------
// 1. playbooks — aggregate root
// ---------------------------------------------------------------------------
// active_version_id is a forward ref to playbook_versions. We use uuid()
// without .references() here to avoid a circular dependency between the two
// table definitions. The FK constraint is expressed as a named check-compatible
// forward reference; the migration applies it via ALTER TABLE after both
// tables exist.
export const playbooks = workflowSchema.table(
  "playbooks",
  {
    ...idMixin("plb"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    // Forward reference — no .references() to avoid circular dependency.
    // The FK to playbook_versions is enforced via a migration ALTER TABLE.
    activeVersionId: uuid("active_version_id"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    visibility: text("visibility").notNull().default("workspace"),
  },
  (t) => ({
    workspaceSlugUniq: uniqueIndex("playbooks_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`deleted_at IS NULL`),
    orgIdx: index("playbooks_org_idx").on(t.orgId, t.workspaceId),
    statusIdx: index("playbooks_status_idx").on(t.workspaceId, t.status),
    slugCheck: check(
      "playbooks_slug_check",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    statusCheck: check(
      "playbooks_status_check",
      sql`${t.status} IN ('draft', 'active', 'archived')`,
    ),
    visibilityCheck: check(
      "playbooks_visibility_check",
      sql`${t.visibility} IN ('private', 'workspace', 'organization', 'marketplace')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 2. playbook_versions — immutable snapshots
// ---------------------------------------------------------------------------
// No updatedAt by design. Once a version is published it is INSERT-only;
// UPDATE grants are withheld at the DB role level. Mutations create a new
// version row; they never mutate an existing one.
export const playbookVersions = workflowSchema.table(
  "playbook_versions",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    playbookId: uuid("playbook_id").notNull(),
    version: integer("version").notNull(),
    changeSummary: text("change_summary"),
    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    playbookVersionUniq: uniqueIndex(
      "playbook_versions_playbook_version_uniq",
    ).on(t.playbookId, t.version),
    playbookIdx: index("playbook_versions_playbook_idx").on(t.playbookId),
    publishedIdx: index("playbook_versions_published_idx").on(
      t.playbookId,
      t.isPublished,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 3. playbook_steps — nodes of the execution graph
// ---------------------------------------------------------------------------
// config holds typed refs (agent_id, tool_id, prompt_id, sub-playbook id)
// validated at publish time and projected as graph edges. JSONB flexibility
// in Postgres; first-class edges in Neo4j (connector dual-write pattern).
export const playbookSteps = workflowSchema.table(
  "playbook_steps",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    // Stable human-readable key within a version (e.g. "fetch_context").
    stepKey: citext("step_key").notNull(),
    name: text("name").notNull(),
    stepType: text("step_type").notNull(),
    isAsync: boolean("is_async").notNull().default(false),
    exitOnError: boolean("exit_on_error").notNull().default(true),
    timeoutSeconds: integer("timeout_seconds"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionKeyUniq: uniqueIndex("playbook_steps_version_key_uniq").on(
      t.playbookVersionId,
      t.stepKey,
    ),
    versionIdx: index("playbook_steps_version_idx").on(t.playbookVersionId),
    stepTypeCheck: check(
      "playbook_steps_step_type_check",
      sql`${t.stepType} IN ('agent','prompt','tool','condition','approval','human_input','transform','loop','parallel','delay','webhook','sub_playbook','knowledge_search','code_execution')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 4. playbook_edges — routing between steps
// ---------------------------------------------------------------------------
export const playbookEdges = workflowSchema.table(
  "playbook_edges",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    sourceStepId: uuid("source_step_id").notNull(),
    targetStepId: uuid("target_step_id").notNull(),
    edgeType: text("edge_type").notNull().default("default"),
    // Required when edge_type = 'conditional'; enforced at publish time (app layer).
    condition: jsonb("condition"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionSrcTgtTypeUniq: uniqueIndex(
      "playbook_edges_version_src_tgt_type_uniq",
    ).on(t.playbookVersionId, t.sourceStepId, t.targetStepId, t.edgeType),
    versionIdx: index("playbook_edges_version_idx").on(t.playbookVersionId),
    sourceIdx: index("playbook_edges_source_idx").on(t.sourceStepId),
    edgeTypeCheck: check(
      "playbook_edges_edge_type_check",
      sql`${t.edgeType} IN ('default','conditional','on_error','loop_back','parallel')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 5. playbook_triggers
// ---------------------------------------------------------------------------
// org_id + workspace_id are deliberately denormalized here. Trigger dispatch
// is a hot path; joining through playbooks on every inbound event adds
// unnecessary latency and a join failure mode. Denormalized columns are
// kept consistent by the application layer on trigger creation.
export const playbookTriggers = workflowSchema.table(
  "playbook_triggers",
  {
    ...idMixin("plt"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookId: uuid("playbook_id").notNull(),
    pinnedVersionId: uuid("pinned_version_id"),
    triggerType: text("trigger_type").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    isEnabled: boolean("is_enabled").notNull().default(false),
  },
  (t) => ({
    playbookIdx: index("playbook_triggers_playbook_idx").on(t.playbookId),
    dispatchIdx: index("playbook_triggers_dispatch_idx")
      .on(t.workspaceId, t.triggerType)
      .where(sql`is_enabled = true`),
    orgIdx: index("playbook_triggers_org_idx").on(t.orgId, t.workspaceId),
    triggerTypeCheck: check(
      "playbook_triggers_trigger_type_check",
      sql`${t.triggerType} IN ('event','schedule','api')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 6. playbook_runs — runtime execution
// ---------------------------------------------------------------------------
// id is a time-ordered UUIDv7 PK — list endpoints can ORDER BY id for
// chronological ordering without an additional created_at index.
export const playbookRuns = workflowSchema.table(
  "playbook_runs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookId: uuid("playbook_id").notNull(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    triggerId: uuid("trigger_id"),
    // Self-referential FK for sub-playbook fan-out; enforced by DB.
    parentRunId: uuid("parent_run_id"),
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    inngestRunId: text("inngest_run_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    startedByUserId: uuid("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    wsStatusCreatedIdx: index("playbook_runs_ws_status_created_idx").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    playbookCreatedIdx: index("playbook_runs_playbook_created_idx").on(
      t.playbookId,
      t.createdAt,
    ),
    parentIdx: index("playbook_runs_parent_idx").on(t.parentRunId),
    inngestIdx: index("playbook_runs_inngest_idx").on(t.inngestRunId),
    sourceCheck: check(
      "playbook_runs_source_check",
      sql`${t.source} IN ('api','event','schedule','manual','sub_playbook')`,
    ),
    statusCheck: check(
      "playbook_runs_status_check",
      sql`${t.status} IN ('pending','running','paused','waiting_approval','completed','failed','cancelled')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 7. playbook_step_runs
// ---------------------------------------------------------------------------
// Retries create new rows (attempt increments); we never UPDATE-in-place.
// This keeps the audit trail intact and simplifies retry attribution.
export const playbookStepRuns = workflowSchema.table(
  "playbook_step_runs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookRunId: uuid("playbook_run_id").notNull(),
    playbookStepId: uuid("playbook_step_id").notNull(),
    // Retries increment attempt; each retry = new row, never an update.
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    // Pins which AgentVersion executed this step for reproducibility.
    agentVersionId: uuid("agent_version_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runStepAttemptUniq: uniqueIndex(
      "playbook_step_runs_run_step_attempt_uniq",
    ).on(t.playbookRunId, t.playbookStepId, t.attempt),
    runIdx: index("playbook_step_runs_run_idx").on(t.playbookRunId),
    stepIdx: index("playbook_step_runs_step_idx").on(t.playbookStepId),
    statusCheck: check(
      "playbook_step_runs_status_check",
      sql`${t.status} IN ('pending','running','waiting_approval','completed','failed','skipped','cancelled')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 8. playbook_events — append-only audit spine with hash chaining
// ---------------------------------------------------------------------------
// Append-only. No UPDATE grants, no DELETEs. Streams to ClickHouse;
// Postgres keeps a bounded retention window (TTL policy in migration).
// prevEventHash = 'genesis' for sequence = 1.
// eventHash = SHA-256 over (prevEventHash || canonical(eventType, eventData, sequence, occurredAt)).
export const playbookEvents = workflowSchema.table(
  "playbook_events",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookRunId: uuid("playbook_run_id").notNull(),
    stepRunId: uuid("step_run_id"),
    // Per-run monotonic counter; used for hash-chain integrity verification.
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data").notNull().default(sql`'{}'::jsonb`),
    // 'genesis' for the first event in a run; SHA-256 of the previous event thereafter.
    prevEventHash: text("prev_event_hash").notNull(),
    // SHA-256 over (prevEventHash || canonical(eventType, eventData, sequence, occurredAt)).
    eventHash: text("event_hash").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    runSeqUniq: uniqueIndex("playbook_events_run_seq_uniq").on(
      t.playbookRunId,
      t.sequence,
    ),
    runIdx: index("playbook_events_run_idx").on(t.playbookRunId),
    occurredIdx: index("playbook_events_occurred_idx").on(
      t.orgId,
      t.occurredAt,
    ),
    eventTypeCheck: check(
      "playbook_events_event_type_check",
      sql`${t.eventType} IN ('run_started','step_started','agent_invoked','tool_called','tool_completed','condition_evaluated','approval_requested','approval_resolved','step_completed','step_failed','step_retried','run_paused','run_resumed','run_completed','run_failed','run_cancelled')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 9. playbook_approvals
// ---------------------------------------------------------------------------
export const playbookApprovals = workflowSchema.table(
  "playbook_approvals",
  {
    ...idMixin("pap"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookRunId: uuid("playbook_run_id").notNull(),
    stepRunId: uuid("step_run_id").notNull(),
    status: text("status").notNull().default("pending"),
    comments: text("comments"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedByUserId: uuid("resolved_by_user_id"),
  },
  (t) => ({
    runIdx: index("playbook_approvals_run_idx").on(t.playbookRunId),
    stepRunIdx: index("playbook_approvals_step_run_idx").on(t.stepRunId),
    statusIdx: index("playbook_approvals_status_idx").on(
      t.workspaceId,
      t.status,
    ),
    statusCheck: check(
      "playbook_approvals_status_check",
      sql`${t.status} IN ('pending','approved','denied','expired')`,
    ),
  }),
);
