import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { aiSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";

// ---------------------------------------------------------------------------
// ai.response_cache — layered response cache for deterministic LLM calls.
//
// Durable cache state lives in Postgres per the four-store law (transactional,
// tenant-scoped). The cache is OPT-IN per call site (@oxagen/ai `cache` option)
// and NEVER engaged for chat/agent-loop calls — only deterministic background
// inference (title generation, classification, enrichment). Every row is
// org/workspace-scoped and RLS-isolated: a cache read can only ever hit an
// entry owned by the same tenant, so there is no cross-tenant leakage.
//
// Two lookup layers, both keyed off this one table:
//   1. Exact match  — `cache_key` = hash(prompt_hash + model + surface + args).
//   2. Semantic     — `embedding` (prompt vector) brute-force cosine-matched
//      against recent entries for the same (org, workspace, model, surface)
//      above a similarity threshold. pgvector is not installed; the semantic
//      layer scans a bounded recent window in-app behind the SemanticIndex
//      interface (see packages/ai/src/cache.ts) — swapping in a pgvector ANN
//      index later is a storage-only change, no caller impact.
// ---------------------------------------------------------------------------
export const aiResponseCache = aiSchema.table(
  "response_cache",
  {
    ...idMixin("aic"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // Exact-match key: sha256 hex of prompt_hash + model + surface + a stable
    // hash of the call's shape (schema/system/temperature). Unique per tenant.
    cacheKey: text("cache_key").notNull(),
    // SHA-256 of the rendered prompt (mirrors token_usage.prompt_hash). PII-free
    // cohort key used for semantic-candidate scoping and observability joins.
    promptHash: text("prompt_hash").notNull(),
    // Resolved model id (gateway `creator/model` slug).
    model: text("model").notNull(),
    // Origin surface (app | api | mcp | cli | ingestion | agent | …).
    surface: text("surface").notNull(),
    // Shape of the cached payload. 'object' for generateObject structured
    // output; 'text' reserved for a future text cache. CHECK mirrors the list.
    responseKind: text("response_kind").notNull().default("object"),
    // The cached result payload — { object } for structured output.
    response: jsonb("response").notNull(),
    // Usage snapshot from the original (cache-miss) call: input/output/cached
    // token counts + cost_usd_micros. Drives the savings figure emitted on hit.
    usage: jsonb("usage").notNull().default(sql`'{}'::jsonb`),
    // Prompt embedding for the semantic layer — number[] as jsonb. NULL when
    // the call site did not opt into semantic matching (exact-match only).
    embedding: jsonb("embedding"),
    // Number of times this entry has served a hit (exact or semantic).
    hitCount: integer("hit_count").notNull().default(0),
    // Wall-clock of the most recent hit; NULL until first served.
    lastHitAt: timestamp("last_hit_at", { withTimezone: true, mode: "date" }),
    // Hard expiry: created_at + ttlSeconds. Reads filter `expires_at > now()`;
    // a sweeper (or soft-delete) reclaims expired rows.
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    // At most one live entry per (workspace, cache_key). Partial on deleted_at
    // so an evicted key can be re-inserted.
    keyUniq: uniqueIndex("ai_response_cache_key_uniq")
      .on(t.orgId, t.workspaceId, t.cacheKey)
      .where(sql`deleted_at IS NULL`),
    // Semantic candidate scan: recent entries for a tenant + model + surface.
    candidateIdx: index("ai_response_cache_candidate_idx").on(
      t.orgId,
      t.workspaceId,
      t.model,
      t.surface,
    ),
    // Expiry sweeper.
    expiresIdx: index("ai_response_cache_expires_idx").on(t.expiresAt),
    responseKindCheck: check(
      "ai_response_cache_response_kind_check",
      sql`${t.responseKind} IN ('object', 'text')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// ai.batch_jobs — tracking record for Anthropic Message Batches submissions.
//
// The Batch API (@oxagen/ai submitBatch/pollBatch) runs deterministic
// background inference asynchronously at half price. One row per submitted
// batch; the durable operational record (status, provider id, per-request
// counts) lives in Postgres — ClickHouse observes token usage on completion
// through the existing metering path. Tenant-scoped and RLS-isolated.
// ---------------------------------------------------------------------------
export const aiBatchJobs = aiSchema.table(
  "batch_jobs",
  {
    ...idMixin("aib"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // Inference provider. Message Batches is an Anthropic first-party endpoint
    // (not proxied by the AI Gateway), so this is 'anthropic' today.
    provider: text("provider").notNull().default("anthropic"),
    // Provider-issued batch id (`msgbatch_…`). NULL only in the brief window
    // between row creation and a successful submit.
    providerBatchId: text("provider_batch_id"),
    // Origin surface for metering attribution.
    surface: text("surface").notNull(),
    // Anthropic model id used for every request in the batch (bare id, e.g.
    // "claude-haiku-4-5" — NOT a gateway slug; batches bypass the gateway).
    model: text("model").notNull(),
    // Lifecycle status. submitted → in_progress → ended; or canceled/expired/
    // failed. CHECK mirrors the IN list.
    status: text("status").notNull().default("submitted"),
    // Total requests submitted in this batch.
    requestCount: integer("request_count").notNull().default(0),
    // Per-result-type tallies, populated as the batch ends.
    succeededCount: integer("succeeded_count").notNull().default(0),
    erroredCount: integer("errored_count").notNull().default(0),
    expiredCount: integer("expired_count").notNull().default(0),
    canceledCount: integer("canceled_count").notNull().default(0),
    // Arbitrary caller metadata (e.g. the ingestion connection id, file batch).
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    // Wall-clocks for the submit → end transition.
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    orgIdx: index("ai_batch_jobs_org_idx").on(t.orgId, t.workspaceId),
    statusIdx: index("ai_batch_jobs_status_idx").on(
      t.orgId,
      t.workspaceId,
      t.status,
    ),
    // One tracking row per provider batch id.
    providerBatchUniq: uniqueIndex("ai_batch_jobs_provider_batch_uniq")
      .on(t.providerBatchId)
      .where(sql`provider_batch_id IS NOT NULL AND deleted_at IS NULL`),
    // Batch reconcile cron (cross-tenant; statusIdx above leads with org_id,
    // which is useless for this cross-tenant scan — 2026-07-11 audit §4.1
    // item 8).
    openIdx: index("ai_batch_jobs_open_idx")
      .on(t.status)
      .where(
        sql`${t.status} IN ('submitted', 'in_progress') AND ${t.deletedAt} IS NULL`,
      ),
    statusCheck: check(
      "ai_batch_jobs_status_check",
      sql`${t.status} IN ('submitted', 'in_progress', 'ended', 'canceled', 'expired', 'failed')`,
    ),
  }),
);
