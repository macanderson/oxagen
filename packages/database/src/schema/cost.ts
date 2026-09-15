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
import { auditMixin, orgScopeMixin, uuidv7Default } from "./_mixins";
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
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** Who observed a figure (spec §12.3, §12.9). `mixed` is a run whose frames differ. */
export const COST_BASES = [
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const RUN_VERDICTS = [
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
  "none",
] as const;

export const ENFORCEMENT_TIERS = ["gateway", "harness", "observe"] as const;
export const REPLAY_GRADES = ["inspect", "view", "fork", "retry"] as const;

/** The levels a daily total is grouped by (spec §12.7). */
export const SPEND_GROUP_KINDS = [
  "operator",
  "agent",
  "model",
  "tool",
  "task",
] as const;
export type SpendGroupKind = (typeof SPEND_GROUP_KINDS)[number];

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
    // A negotiated or override row belongs to an organization; a list row to none.
    orgSourceCheck: check(
      "price_entries_org_source_check",
      sql`(${t.source} = 'list') = (${t.orgId} IS NULL)`,
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
    agentPrincipalId: uuid("agent_principal_id"),
    // `org_ns.ws_ns.slug` (ADR-024); the level "by agent" groups on.
    agentKey: text("agent_key"),
    taskRef: text("task_ref"),
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
    enforcementTier: text("enforcement_tier"),
    replayGrade: text("replay_grade"),
    governedActions: integer("governed_actions"),
    billedAt: timestamp("billed_at", { withTimezone: true, mode: "date" }),
    // Per-model and per-tool folds of the same frames, so the daily rollup and
    // the drill pages need no second read of the frame store:
    // { models: [{ model, provider, calls, tokens, costMicros, basis }],
    //   tools:  [{ name, calls }] }
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
    ratiosCheck: check(
      "run_totals_ratios_check",
      sql`(${t.cacheHitRate} IS NULL OR (${t.cacheHitRate} >= 0 AND ${t.cacheHitRate} <= 1)) AND (${t.productiveRatio} IS NULL OR (${t.productiveRatio} >= 0 AND ${t.productiveRatio} <= 1))`,
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
    // operator: the principal's uuid · agent: the agent key · model: the model
    // id · tool: the tool or capability name · task: the task reference.
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
