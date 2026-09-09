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
