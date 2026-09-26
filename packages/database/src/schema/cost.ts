// cost.* — the price book as data and the spend rollups (Mission Control spec
// §12.2, §12.3, §12.7, App. A.7; ADR-060).
//
// `price_entries` holds every price Oxagen applies: the provider list prices
// `pnpm billing:price-book-sync` writes from packages/billing/src/pricing.ts
// (org_id NULL, source 'list') and an organization's negotiated rows (org_id
// set). A price is effective over [effective_from, effective_to); a correction
// is a new row with a later effective_from, never an update in place, so a
// recomputed cost record names the entry it used.
//
// `run_totals` and `daily_totals` are derived indexes. The frame is the record:
// the rollup job (packages/inngest-functions cost.run-rollup) rebuilds a run's
// row from its model-call and tool-call frames after each seal, and the nightly
// cost.daily-rollup folds run rows into the workspace's per-day groups. Both
// tables can be dropped and rebuilt. Every money column is integer micro-USD;
// a null cost is a run or group no frame priced, never a zero.
//
// `price_book_initializations` is one row per price book: when it was
// initialized and which catalogs answered completely then. The cold-start
// floor needs that set, and it cannot be read back off `price_entries`,
// because a catalog whose every model lost to a higher-precedence source
// contributed no row (ADR-103).
//
// `findings` is the findings job's output (spec §12.8; ADR-062): one open row
// per (workspace, kind, subject) the detectors see in the trailing window,
// replaced on every pass; a row a person applied or dismissed is kept with
// the decision on it, and the detectors cite only runs that started after it.
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { costSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";
import { organizations } from "./org";

/** The token classes a price entry may price (spec §12.6 plus the per-asset media units). */
export const PRICE_TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
] as const;
export type PriceTokenClass = (typeof PRICE_TOKEN_CLASSES)[number];

/** What one unit of a token class is; `micros_per_million` prices a million of them. */
export const PRICE_UNITS = ["token", "request", "image", "second"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PRICE_SOURCES = ["list", "negotiated", "override"] as const;

/**
 * The book `price_book_initializations` records. One value today: the platform
 * list book every organization reads, which is the only book with a cold
 * start.
 */
export const PRICE_BOOK_LIST = "list";

export type PriceSource = (typeof PRICE_SOURCES)[number];

/** Who observed a figure (spec §12.3, §12.9). `mixed` is a run whose frames differ. */
export const COST_BASES = [
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
] as const;
export type CostBasis = (typeof COST_BASES)[number];

// The witness verdicts (@oxagen/run-evidence, spec §8.5) plus `none`, the
// rollup's word for a run no witness reported on (App. A.7).
export const RUN_VERDICTS = [...PROOF_VERDICTS, "none"] as const;

export const ENFORCEMENT_TIERS = [
  "contained",
  "gateway",
  "harness",
  "observe",
] as const;
export const REPLAY_GRADES = ["inspect", "view", "fork", "retry"] as const;

/** The levels a daily total is grouped by (spec §12.7). */
export const SPEND_GROUP_KINDS = [
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
] as const;
export type SpendGroupKind = (typeof SPEND_GROUP_KINDS)[number];

/**
 * A cost-center label: what finance charges spend back to. One to 64
 * characters, starting with a letter or digit, then letters, digits, `.`, `_`
 * or `-` (`ENG-1001`, `marketing.emea`). The same pattern is the CHECK on
 * every column that holds one and the contract's schema.
 */
export const COST_CENTER_LABEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/**
 * The `cost_center` group key of spend no cost center claims. The label
 * pattern refuses `~`, so no real label can collide with it. Every run lands
 * in exactly one `cost_center` group, this one included, so the level's rows
 * sum to the period total by construction.
 */
export const UNASSIGNED_COST_CENTER_KEY = "~none";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(","));

// ── price_entries ─────────────────────────────────────────────────────────────
export const priceEntries = costSchema.table(
  "price_entries",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...auditMixin(),
    // NULL ⇒ the platform list price every organization reads; set ⇒ that
    // organization's negotiated rate, which wins over the list row.
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    // The canonical model id the frame reports; a versioned id resolves to
    // the longest prefix among `model` and `model_aliases`.
    model: text("model").notNull(),
    modelAliases: text("model_aliases").array().notNull().default([]),
    region: text("region"),
    tokenClass: text("token_class").notNull(),
    unit: text("unit").notNull(),
    currency: text("currency").notNull().default("USD"),
    // Integer micro-USD per one million units: $3.00 per 1M input tokens is
    // 3_000_000. Per-frame cost is tokens × this ÷ 1_000_000 at full precision.
    microsPerMillion: bigint("micros_per_million", {
      mode: "bigint",
    }).notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    effectiveTo: timestamp("effective_to", {
      withTimezone: true,
      mode: "date",
    }),
    source: text("source").notNull(),
    /**
     * Which published catalog a list row came from (`openrouter`,
     * `models_dev`, `in_code_card`, `operator_override`), or null for a
     * negotiated row. Retirement is per catalog: a row absent from a catalog
     * that answered completely is a price that ended, while a row from a
     * catalog that failed this run is preserved. Without this the sync could
     * only retire on a run where EVERY catalog answered, and a model one
     * catalog withdrew stayed priced for as long as any other was down.
     */
    catalog: text("catalog"),
  },
  (t) => ({
    // One row per (catalog or org, provider, model, class, region, start).
    keyIdx: uniqueIndex("price_entries_key_idx").on(
      sql`coalesce(${t.orgId}, '${sql.raw(NIL_UUID)}'::uuid)`,
      t.provider,
      t.model,
      t.tokenClass,
      sql`coalesce(${t.region}, '')`,
      t.effectiveFrom,
    ),
    lookupIdx: index("price_entries_lookup_idx").on(t.model, t.tokenClass),
    tokenClassCheck: check(
      "price_entries_token_class_check",
      sql`${t.tokenClass} IN (${inList(PRICE_TOKEN_CLASSES)})`,
    ),
    unitCheck: check(
      "price_entries_unit_check",
      sql`${t.unit} IN (${inList(PRICE_UNITS)})`,
    ),
    sourceCheck: check(
      "price_entries_source_check",
      sql`${t.source} IN (${inList(PRICE_SOURCES)})`,
    ),
    // A negotiated row belongs to an organization. A list row (a published
    // catalog or the in-code card) and an override row (this installation's
    // operator-set rate) belong to none: both are the platform's, and the
    // source is what tells them apart so a withdrawn override can retire on a
    // run where a catalog is down.
    orgSourceCheck: check(
      "price_entries_org_source_check",
      sql`(${t.source} IN ('list', 'override')) = (${t.orgId} IS NULL)`,
    ),
    priceCheck: check(
      "price_entries_price_check",
      sql`${t.microsPerMillion} >= 0`,
    ),
    rangeCheck: check(
      "price_entries_effective_range_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  }),
);

// ── price_book_initializations ───────────────────────────────────────────────
/**
 * One row per price book, recording that the book was initialized and which
 * catalogs answered completely at that instant (ADR-103).
 *
 * The cold-start floor backdates a key the book has never priced to an
 * instant before every frame, so frames recorded before the first sync price
 * at the first known rate rather than at nothing. It must fire only for a
 * source that was down at initialization and has since come back. That set
 * used to be reconstructed from `price_entries`: the `catalog` stamped on the
 * rows created at the book's earliest instant. A catalog that answered at the
 * first sync and lost every model to a higher-precedence source writes no row,
 * so the reconstruction could not tell it from a catalog that was down, and
 * its first unique model inside the cold window was backdated and repriced
 * runs that had already settled.
 *
 * Per install, not per organization: `book = 'list'` is the platform list
 * price book, the only book with a cold start. No org or workspace column and
 * no RLS policy, like the other shared catalogs. The sync reads and writes it
 * through `withSystemDb`.
 */
export const priceBookInitializations = costSchema.table(
  "price_book_initializations",
  {
    book: text("book").primaryKey(),
    ...auditMixin(),
    /** The instant the book's first rows were written, in their transaction. */
    initializedAt: timestamp("initialized_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * The catalogs that answered completely at that instant, by id. A key a
     * catalog outside this set names for the first time while the book is
     * still cold is that source recovering, and is floored; a key a catalog
     * inside it names for the first time is a model that did not exist before,
     * and starts at the requested boundary.
     */
    completedCatalogs: text("completed_catalogs").array().notNull().default([]),
  },
  (t) => ({
    // One book has a cold start: the platform list book. A negotiated book is
    // an organization's own and begins when its contract does, so there is no
    // window in which its first rows stand in for earlier frames.
    bookCheck: check(
      "price_book_initializations_book_check",
      sql`${t.book} IN ('${sql.raw(PRICE_BOOK_LIST)}')`,
    ),
  }),
);

// ── run_totals ────────────────────────────────────────────────────────────────
export const runTotals = costSchema.table(
  "run_totals",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    // The run's public id: `arun_…` (evidence ledger) or `tse_…` (tacho).
    runId: text("run_id").notNull().unique(),
    runSource: text("run_source").notNull(),
    operatorPrincipalId: uuid("operator_principal_id"),
    // The operator's public id (`prn_…`); the level "by operator" groups on
    // and the drill filters on, so the wire never carries the uuid.
    operatorKey: text("operator_key"),
    agentPrincipalId: uuid("agent_principal_id"),
    // `org_ns.ws_ns.slug` (ADR-024); the level "by agent" groups on.
    agentKey: text("agent_key"),
    taskRef: text("task_ref"),
    // The cost center the run's spend is charged back to, resolved at rollup:
    // the agent's live label, else the workspace's, else null. The level
    // "by cost center" groups on it, with null under UNASSIGNED_COST_CENTER_KEY.
    costCenter: text("cost_center"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    sealedAt: timestamp("sealed_at", { withTimezone: true, mode: "date" }),
    // Null when the frames hide the turn index (an encrypted ledger payload).
    turns: integer("turns"),
    steps: integer("steps").notNull(),
    modelCalls: integer("model_calls").notNull(),
    toolCalls: integer("tool_calls").notNull(),
    // Integer counts by token class; an absent class is 0 (spec §12.6).
    tokens: jsonb("tokens").notNull(),
    // Null when no model frame was priced; then cost_basis is null too.
    costMicros: bigint("cost_micros", { mode: "bigint" }),
    currency: text("currency").notNull().default("USD"),
    costBasis: text("cost_basis"),
    // Every price entry a frame of this run was priced with (spec §12.2).
    priceEntryIds: uuid("price_entry_ids").array().notNull().default([]),
    // cache_read ÷ (input_uncached + cache_read), spend-weighted over the
    // run's frames; null when no frame carried input tokens.
    cacheHitRate: numeric("cache_hit_rate", { precision: 9, scale: 8 }),
    // Measured prompt composition (spec §12.6); null until a recorder measures it.
    toolDefinitionTokens: integer("tool_definition_tokens"),
    contextFrameTokens: integer("context_frame_tokens"),
    steeringTokens: integer("steering_tokens"),
    retries: integer("retries"),
    // Proof and value (spec §12.8); null until the witness and grading lanes write them.
    verdict: text("verdict"),
    accepted: boolean("accepted"),
    productiveRatio: numeric("productive_ratio", { precision: 9, scale: 8 }),
    // The steps that advanced the run and the steps that did not (#3984).
    // Null together until the rollup grades the run, and summing to `steps`
    // once it has; `productive_ratio` is advanced_steps / steps. Why each
    // unproductive step made no progress rides the breakdown jsonb.
    advancedSteps: integer("advanced_steps"),
    unproductiveSteps: integer("unproductive_steps"),
    enforcementTier: text("enforcement_tier"),
    replayGrade: text("replay_grade"),
    governedActions: integer("governed_actions"),
    billedAt: timestamp("billed_at", { withTimezone: true, mode: "date" }),
    // Per-model and per-tool folds of the same frames, so the daily rollup and
    // the drill pages need no second read of the frame store:
    // { models: [{ model, provider, calls, tokens, costMicros, basis }],
    //   tools:  [{ name, calls, resultTokens, costMicros }],
    //   steps:  { failed, repeated, retried } | null }
    // A row written before `resultTokens`, `costMicros` or `steps` revives
    // with them null.
    breakdown: jsonb("breakdown").notNull(),
    rolledUpAt: timestamp("rolled_up_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    workspaceStartedIdx: index("run_totals_workspace_started_idx").on(
      t.workspaceId,
      t.startedAt,
    ),
    // The agent's baseline: its sealed runs in the 30 days before a run
    // started (`get_run_cost`, #3984).
    agentStartedIdx: index("run_totals_agent_started_idx").on(
      t.workspaceId,
      t.agentKey,
      t.startedAt,
    ),
    sourceCheck: check(
      "run_totals_source_check",
      sql`${t.runSource} IN ('ledger','tacho')`,
    ),
    basisCheck: check(
      "run_totals_basis_check",
      sql`${t.costBasis} IS NULL OR ${t.costBasis} IN (${inList(COST_BASES)})`,
    ),
    costBasisPairCheck: check(
      "run_totals_cost_basis_pair_check",
      sql`(${t.costMicros} IS NULL) = (${t.costBasis} IS NULL)`,
    ),
    verdictCheck: check(
      "run_totals_verdict_check",
      sql`${t.verdict} IS NULL OR ${t.verdict} IN (${inList(RUN_VERDICTS)})`,
    ),
    tierCheck: check(
      "run_totals_tier_check",
      sql`${t.enforcementTier} IS NULL OR ${t.enforcementTier} IN (${inList(ENFORCEMENT_TIERS)})`,
    ),
    gradeCheck: check(
      "run_totals_grade_check",
      sql`${t.replayGrade} IS NULL OR ${t.replayGrade} IN (${inList(REPLAY_GRADES)})`,
    ),
    countsCheck: check(
      "run_totals_counts_check",
      sql`${t.steps} >= 0 AND ${t.modelCalls} >= 0 AND ${t.toolCalls} >= 0 AND (${t.turns} IS NULL OR ${t.turns} >= 0) AND (${t.retries} IS NULL OR ${t.retries} >= 0) AND (${t.governedActions} IS NULL OR ${t.governedActions} >= 0)`,
    ),
    costCenterCheck: check(
      "run_totals_cost_center_check",
      sql`${t.costCenter} IS NULL OR ${t.costCenter} ~ '${sql.raw(COST_CENTER_LABEL_PATTERN)}'`,
    ),
    ratiosCheck: check(
      "run_totals_ratios_check",
      sql`(${t.cacheHitRate} IS NULL OR (${t.cacheHitRate} >= 0 AND ${t.cacheHitRate} <= 1)) AND (${t.productiveRatio} IS NULL OR (${t.productiveRatio} >= 0 AND ${t.productiveRatio} <= 1))`,
    ),
    stepsGradedCheck: check(
      "run_totals_steps_graded_check",
      sql`(${t.advancedSteps} IS NULL) = (${t.unproductiveSteps} IS NULL) AND (${t.advancedSteps} IS NULL OR (${t.advancedSteps} >= 0 AND ${t.unproductiveSteps} >= 0 AND ${t.advancedSteps} + ${t.unproductiveSteps} = ${t.steps}))`,
    ),
  }),
);

// ── daily_totals ──────────────────────────────────────────────────────────────
export const dailyTotals = costSchema.table(
  "daily_totals",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    // The UTC day the runs started on.
    day: date("day", { mode: "string" }).notNull(),
    groupKind: text("group_kind").notNull(),
    // operator: the principal's public id (`prn_…`) · agent: the agent key ·
    // model: the model id · tool: the tool or capability name · task: the
    // task reference · cost_center: the label, or UNASSIGNED_COST_CENTER_KEY.
    groupKey: text("group_key").notNull(),
    // Set on model rows.
    provider: text("provider"),
    runs: integer("runs").notNull(),
    // Model calls on model rows, tool calls on tool rows, steps elsewhere.
    calls: integer("calls").notNull(),
    costMicros: bigint("cost_micros", { mode: "bigint" }),
    currency: text("currency").notNull().default("USD"),
    costBasis: text("cost_basis"),
    // Spend on runs whose verdict is `flipped`, and on runs a human accepted
    // (spec §12.8); null until any run in the group carries a verdict.
    provenMicros: bigint("proven_micros", { mode: "bigint" }),
    acceptedMicros: bigint("accepted_micros", { mode: "bigint" }),
    productiveRatio: numeric("productive_ratio", { precision: 9, scale: 8 }),
    tokens: jsonb("tokens").notNull(),
    rolledUpAt: timestamp("rolled_up_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    groupIdx: uniqueIndex("daily_totals_group_idx").on(
      t.workspaceId,
      t.day,
      t.groupKind,
      t.groupKey,
    ),
    kindCheck: check(
      "daily_totals_kind_check",
      sql`${t.groupKind} IN (${inList(SPEND_GROUP_KINDS)})`,
    ),
    basisCheck: check(
      "daily_totals_basis_check",
      sql`${t.costBasis} IS NULL OR ${t.costBasis} IN (${inList(COST_BASES)})`,
    ),
    costBasisPairCheck: check(
      "daily_totals_cost_basis_pair_check",
      sql`(${t.costMicros} IS NULL) = (${t.costBasis} IS NULL)`,
    ),
    countsCheck: check(
      "daily_totals_counts_check",
      sql`${t.runs} >= 0 AND ${t.calls} >= 0`,
    ),
  }),
);

// ── cost_centers ──────────────────────────────────────────────────────────────
/**
 * The organization's list of valid cost-center labels. An agent's or a
 * workspace's `cost_center` must name a live row here when it is written; the
 * rollup reads the agent's label first, then the workspace's, and a label
 * whose row is soft-deleted no longer claims new rollups.
 *
 * One row per (org, label) for ever, deleted rows included, like an agent
 * slug: a statement keyed by label then names one row across its history, and
 * adding a deleted label back restores that row rather than minting another.
 */
export const costCenters = costSchema.table(
  "cost_centers",
  {
    ...idMixin("ccn"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: citext("label").notNull(),
    description: text("description"),
  },
  (t) => ({
    orgLabelIdx: uniqueIndex("cost_centers_org_label_idx").on(t.orgId, t.label),
    labelCheck: check(
      "cost_centers_label_check",
      sql`${t.label} ~ '${sql.raw(COST_CENTER_LABEL_PATTERN)}'`,
    ),
  }),
);

// ── findings ──────────────────────────────────────────────────────────────────
/**
 * What the detectors can prove from the recorded frames today (spec §12.8
 * and the mockup's Spend › Findings; ADR-062's detector table names the
 * field every other §12.8 row waits on).
 */
export const FINDING_KINDS = [
  "cache_writes_never_read",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "unpaged_results",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Where the fix applies: the level whose key `subject` carries. */
const FINDING_LEVELS = ["tool", "agent", "operator", "workspace"] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];

/** `high` when the counterfactual covers at least nine in ten cited calls (ADR-062 §3). */
const FINDING_CONFIDENCES = ["high", "medium"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

const FINDING_STATUSES = ["open", "applied", "dismissed"] as const;

export const findings = costSchema.table(
  "findings",
  {
    ...idMixin("fnd"),
    ...orgScopeMixin(),
    kind: text("kind").notNull(),
    level: text("level").notNull(),
    // The level's key: a tool name, an agent key (`org_ns.ws_ns.slug`), an
    // operator's principal public id (`prn_…`), or the workspace id.
    subject: text("subject").notNull(),
    // `kind|level|subject`: the identity a pass upserts on while the row is open.
    fingerprint: text("fingerprint").notNull(),
    windowStart: timestamp("window_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    windowEnd: timestamp("window_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    // Measured minus counterfactual over the cited runs, at the price each
    // call paid (ADR-062 §3); the basis is the fold of the cited runs' bases.
    estimatedSavingMicros: bigint("estimated_saving_micros", {
      mode: "bigint",
    }).notNull(),
    currency: text("currency").notNull().default("USD"),
    savingBasis: text("saving_basis").notNull(),
    confidence: text("confidence").notNull(),
    why: text("why").notNull(),
    fix: text("fix").notNull(),
    citedRuns: text("cited_runs").array().notNull(),
    // The arithmetic behind the saving: the signal, the counterfactual, the
    // call counts and one entry per cited run (`FindingEvidence` on the
    // contract). Since #4001 it also holds `frames`, the cited calls per run;
    // a row written before that has no `frames` key and reads as not cited.
    citedFrames: jsonb("cited_frames").notNull(),
    status: text("status").notNull().default("open"),
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decidedByUserId: uuid("decided_by_user_id"),
    // The request id of the invocation that applied the fix: the key its
    // audit row carries. Set with status `applied`, null otherwise.
    appliedActionId: text("applied_action_id"),
  },
  (t) => ({
    openIdx: uniqueIndex("findings_open_fingerprint_idx")
      .on(t.workspaceId, t.fingerprint)
      .where(sql`${t.status} = 'open'`),
    workspaceStatusIdx: index("findings_workspace_status_idx").on(
      t.workspaceId,
      t.status,
      t.estimatedSavingMicros,
    ),
    kindCheck: check(
      "findings_kind_check",
      sql`${t.kind} IN (${inList(FINDING_KINDS)})`,
    ),
    levelCheck: check(
      "findings_level_check",
      sql`${t.level} IN (${inList(FINDING_LEVELS)})`,
    ),
    confidenceCheck: check(
      "findings_confidence_check",
      sql`${t.confidence} IN (${inList(FINDING_CONFIDENCES)})`,
    ),
    statusCheck: check(
      "findings_status_check",
      sql`${t.status} IN (${inList(FINDING_STATUSES)})`,
    ),
    basisCheck: check(
      "findings_basis_check",
      sql`${t.savingBasis} IN (${inList(COST_BASES)})`,
    ),
    savingCheck: check(
      "findings_saving_check",
      sql`${t.estimatedSavingMicros} > 0`,
    ),
    windowCheck: check(
      "findings_window_check",
      sql`${t.windowEnd} > ${t.windowStart}`,
    ),
    // A finding cites at least one run: one without cited frames is not written.
    citedCheck: check(
      "findings_cited_check",
      sql`cardinality(${t.citedRuns}) > 0`,
    ),
    // An open row has no decision; a decided row has one, and only an
    // applied row carries the action id.
    decisionCheck: check(
      "findings_decision_check",
      sql`(${t.status} = 'open') = (${t.decidedAt} IS NULL) AND (${t.status} = 'applied') = (${t.appliedActionId} IS NOT NULL)`,
    ),
  }),
);
