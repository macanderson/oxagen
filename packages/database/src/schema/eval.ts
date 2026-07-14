import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  auditMixin,
  citext,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
} from "./_mixins";
import { evalSchema } from "./_schemas";

// Evals v1 — datasets + LLM-as-judge runs, tenant-scoped in Postgres.
//
// Wedge alignment (docs/VISION.md): Oxagen does NOT compete on standalone eval
// platforms (that is Braintrust's front line). These tables exist only to score
// what actually ran and got billed — datasets can be built from the already-
// metered run traces (see eval.dataset.from_traces) and every run's target and
// judge calls flow through @oxagen/ai so they land in the same metering pipe.
//
// Store split: dataset definitions, dataset items, and run summaries are durable
// transactional state → Postgres. Per-item run RESULTS (output, score, tokens,
// latency, cost) are append-only runtime events → ClickHouse eval_item_results
// (packages/telemetry). No cross-schema FKs — references are app-enforced.

/** A named collection of eval cases owned by a workspace. */
export const evalDatasets = evalSchema.table(
  "eval_datasets",
  {
    ...idMixin("evd"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    // How the dataset was seeded: hand-authored, or captured from metered traces.
    source: text("source").notNull().default("manual"),
    // Denormalized item count kept in sync on item.add so list views avoid a
    // COUNT(*) per row (N+1 on the list page).
    itemCount: integer("item_count").notNull().default(0),
  },
  (t) => ({
    // One live dataset per (workspace, slug).
    workspaceSlugUniq: uniqueIndex("eval_datasets_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`deleted_at IS NULL`),
    orgIdx: index("eval_datasets_org_idx").on(t.orgId, t.workspaceId),
    sourceCheck: check(
      "eval_datasets_source_check",
      sql`${t.source} IN ('manual','traces')`,
    ),
  }),
);

/** One case within a dataset: the input, an optional gold answer, and metadata. */
export const evalDatasetItems = evalSchema.table(
  "eval_dataset_items",
  {
    ...idMixin("evi"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // App-enforced FK to eval_datasets.id (no cross-nothing; same schema, but we
    // keep the app-enforced convention uniform across the codebase).
    datasetId: uuid("dataset_id").notNull(),
    input: text("input").notNull(),
    expectedOutput: text("expected_output"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    datasetIdx: index("eval_dataset_items_dataset_idx").on(t.datasetId),
    orgIdx: index("eval_dataset_items_org_idx").on(t.orgId, t.workspaceId),
  }),
);

/** A run of a dataset through a target, judged by an LLM. Summary lives here;
 * per-item detail lands in ClickHouse eval_item_results. */
export const evalRuns = evalSchema.table(
  "eval_runs",
  {
    ...idMixin("evr"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    datasetId: uuid("dataset_id").notNull(),
    name: text("name"),
    // Discriminated target descriptor { kind: 'model'|'agent', ... }. Validated
    // against evalTargetSchema at the contract boundary before persistence.
    target: jsonb("target").notNull(),
    // Resolved gateway model id the judge ran with (recorded for reproducibility).
    judgeModel: text("judge_model").notNull(),
    // Score at/above which an item counts as passing.
    passThreshold: numeric("pass_threshold").notNull().default("0.7"),
    status: citext("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    // Mean overall judge score across completed items; null until the run finishes.
    avgScore: numeric("avg_score"),
    // Aggregate rubric breakdown, e.g. { correctness, faithfulness, passRate }.
    scoreBreakdown: jsonb("score_breakdown")
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    datasetIdx: index("eval_runs_dataset_idx").on(t.datasetId),
    orgIdx: index("eval_runs_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check(
      "eval_runs_status_check",
      sql`${t.status} IN ('pending','queued','running','completed','failed','cancelled')`,
    ),
  }),
);
