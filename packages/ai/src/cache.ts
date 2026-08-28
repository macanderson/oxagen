import { createHash } from "node:crypto";
import pino from "pino";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { insertEvents, type Surface } from "@oxagen/telemetry";
import { embedText } from "./embed";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.cache" },
});

/**
 * Per-call-site cache configuration. Caching is OPT-IN: a call with no `cache`
 * option behaves exactly as before. NEVER attach this to chat/agent-loop calls
 * — target deterministic background inference (titles, classification,
 * enrichment) where an identical (or near-identical) prompt yields the same
 * answer and staleness is acceptable within the TTL.
 */
export interface CacheOptions {
  /** Time-to-live in seconds. An entry older than this is treated as a miss. */
  ttlSeconds: number;
  /**
   * When true, a lookup that misses the exact-match layer falls back to a
   * semantic layer: the prompt is embedded and cosine-matched against recent
   * cached entries for the same tenant/model/surface. Costs one embedding call
   * per miss, so enable it only where the LLM call it may save is much pricier
   * than an embedding (the usual case).
   */
  semantic?: boolean;
  /**
   * Minimum cosine similarity (0–1) for a semantic hit. Defaults to 0.95 —
   * deliberately strict so a "hit" is a genuine paraphrase, not a topically
   * related but semantically different prompt.
   */
  similarityThreshold?: number;
  /**
   * Cap on the recent-window candidate scan for the semantic layer. Defaults to
   * 50. The window is ordered newest-first; a pgvector ANN index would replace
   * this bounded scan without changing the caller.
   */
  maxCandidates?: number;
}

/** Payload shape stored per entry. Only `object` is produced today. */
export type CachedResponseKind = "object" | "text";

/** Usage snapshot carried on an entry — the spend a hit avoids. */
export interface CachedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Prompt-cache write tokens on the original call. Older stored entries may have 0. */
  cacheWriteTokens: number;
  costUsdMicros: number;
}

/** Result of a cache read. `null` embedding means no vector was computed. */
export interface CacheReadResult<T> {
  /** The cached value + provenance, or null on a miss. */
  hit: {
    value: T;
    usage: CachedUsage;
    kind: CachedResponseKind;
    /** true when served by the semantic layer, false for exact match. */
    semantic: boolean;
    /** Cosine similarity for a semantic hit; 1 for an exact hit. */
    similarity: number;
  } | null;
  /**
   * The prompt embedding computed during a semantic miss, so the caller can
   * reuse it for the subsequent write instead of embedding the prompt twice.
   * Undefined when semantic was off or the exact layer hit.
   */
  queryEmbedding?: number[];
}

/** Tenant + attribution context every cache operation needs. */
export interface CacheContext {
  orgId: string;
  workspaceId: string;
  surface: Surface;
  /** SHA-256 of the rendered prompt (mirrors token_usage.prompt_hash). */
  promptHash: string;
  /** Resolved model id (gateway slug). */
  model: string;
  /**
   * Stable hash of the call's shape (schema + system + temperature). Folded
   * into the exact-match key so two calls that share a prompt but differ in
   * output schema do not collide.
   */
  shapeHash: string;
  /** Rendered prompt text — only used to embed for the semantic layer. */
  promptText: string;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
const DEFAULT_MAX_CANDIDATES = 50;

/** SHA-256 hex of an arbitrary string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build the exact-match key. Any change to prompt hash, model, surface, or
 * call shape yields a different key, so a hit is only ever a byte-identical
 * request within one tenant.
 */
export function buildCacheKey(ctx: {
  promptHash: string;
  model: string;
  surface: string;
  shapeHash: string;
}): string {
  return sha256Hex(
    [ctx.promptHash, ctx.model, ctx.surface, ctx.shapeHash].join("|"),
  );
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 when either vector
 * is degenerate (zero magnitude) or the lengths differ — a safe "no match".
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Row shape returned by the candidate scan — kept narrow so a pgvector-backed
// implementation can satisfy the same contract.
interface CacheRow {
  id: string;
  response: unknown;
  usage: unknown;
  responseKind: string;
  embedding: unknown;
}

function toUsage(raw: unknown): CachedUsage {
  const u = (raw ?? {}) as Partial<CachedUsage>;
  return {
    model: typeof u.model === "string" ? u.model : "",
    inputTokens: Number(u.inputTokens ?? 0),
    outputTokens: Number(u.outputTokens ?? 0),
    cachedTokens: Number(u.cachedTokens ?? 0),
    cacheWriteTokens: Number(u.cacheWriteTokens ?? 0),
    costUsdMicros: Number(u.costUsdMicros ?? 0),
  };
}

function toEmbedding(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number") return null;
    out.push(v);
  }
  return out;
}

/**
 * Emit a cache hit/miss event to ClickHouse through the metering path so the
 * observed savings are measurable (that is the wedge: observed usage → billing).
 * Best-effort — a telemetry failure must never affect the caller.
 */
function emitCacheEvent(
  ctx: CacheContext,
  kind: "hit" | "miss",
  detail: { semantic: boolean; similarity: number; saved?: CachedUsage },
): void {
  const payload = {
    model: ctx.model,
    surface: ctx.surface,
    prompt_hash: ctx.promptHash,
    semantic: detail.semantic,
    similarity: detail.similarity,
    saved_input_tokens: detail.saved?.inputTokens ?? 0,
    saved_output_tokens: detail.saved?.outputTokens ?? 0,
    saved_cost_usd_micros: detail.saved?.costUsdMicros ?? 0,
  };
  // Fire-and-forget; never await in a way that could fail the caller.
  void Promise.resolve(
    insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: `ai.cache.${kind}`,
        source_system: "ai",
        stream_offset: null,
        payload: JSON.stringify(payload),
        emitted_at: new Date().toISOString(),
      },
    ]),
  ).catch((err: unknown) => {
    logger.error({ err }, "cache event write failed");
  });
}

/**
 * Read the cache for a deterministic call. Tries the exact layer first, then
 * (when `options.semantic`) a bounded cosine scan of recent entries. Emits a
 * hit/miss event either way. Returns the query embedding on a semantic miss so
 * the caller can reuse it for the write.
 *
 * Best-effort by contract: any DB error is swallowed and reported as a miss —
 * a cache outage must never fail the underlying LLM call.
 */
export async function readCache<T>(
  ctx: CacheContext,
  options: CacheOptions,
): Promise<CacheReadResult<T>> {
  const cacheKey = buildCacheKey(ctx);
  const scope: TenantScope = getScope() ?? {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };

  try {
    return await runInTenantScope(scope, async () => {
      // ── Exact-match layer ──────────────────────────────────────────────────
      const exact = await withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.aiResponseCache.id,
            response: schema.aiResponseCache.response,
            usage: schema.aiResponseCache.usage,
            responseKind: schema.aiResponseCache.responseKind,
            embedding: schema.aiResponseCache.embedding,
          })
          .from(schema.aiResponseCache)
          .where(
            and(
              eq(schema.aiResponseCache.orgId, ctx.orgId),
              eq(schema.aiResponseCache.workspaceId, ctx.workspaceId),
              eq(schema.aiResponseCache.cacheKey, cacheKey),
              isNull(schema.aiResponseCache.deletedAt),
              gt(schema.aiResponseCache.expiresAt, new Date()),
            ),
          )
          .limit(1);
        return rows[0] as CacheRow | undefined;
      });

      if (exact) {
        await bumpHit(exact.id, ctx).catch((err: unknown) =>
          logger.debug(
            { err, cacheId: exact.id },
            "cache: bumpHit failed (non-fatal)",
          ),
        );
        const usage = toUsage(exact.usage);
        emitCacheEvent(ctx, "hit", {
          semantic: false,
          similarity: 1,
          saved: usage,
        });
        return {
          hit: {
            value: exact.response as T,
            usage,
            kind: exact.responseKind as CachedResponseKind,
            semantic: false,
            similarity: 1,
          },
        };
      }

      // ── Semantic layer (opt-in) ────────────────────────────────────────────
      if (!options.semantic) {
        emitCacheEvent(ctx, "miss", { semantic: false, similarity: 0 });
        return { hit: null };
      }

      const threshold =
        options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
      const limit = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

      // Embed the prompt for the vector lookup. Metered via embedText; no
      // execution step to attribute (background inference).
      const queryEmbedding = await embedText(ctx.promptText, {
        telemetry: {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          surface: ctx.surface,
          executionStepId: null,
        },
      });

      const candidates = await withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.aiResponseCache.id,
            response: schema.aiResponseCache.response,
            usage: schema.aiResponseCache.usage,
            responseKind: schema.aiResponseCache.responseKind,
            embedding: schema.aiResponseCache.embedding,
          })
          .from(schema.aiResponseCache)
          .where(
            and(
              eq(schema.aiResponseCache.orgId, ctx.orgId),
              eq(schema.aiResponseCache.workspaceId, ctx.workspaceId),
              eq(schema.aiResponseCache.model, ctx.model),
              eq(schema.aiResponseCache.surface, ctx.surface),
              isNull(schema.aiResponseCache.deletedAt),
              gt(schema.aiResponseCache.expiresAt, new Date()),
              sql`${schema.aiResponseCache.embedding} IS NOT NULL`,
            ),
          )
          .orderBy(desc(schema.aiResponseCache.createdAt))
          .limit(limit);
        return rows as CacheRow[];
      });

      let best: { row: CacheRow; similarity: number } | null = null;
      for (const row of candidates) {
        const emb = toEmbedding(row.embedding);
        if (!emb) continue;
        const similarity = cosineSimilarity(queryEmbedding, emb);
        if (
          similarity >= threshold &&
          (!best || similarity > best.similarity)
        ) {
          best = { row, similarity };
        }
      }

      if (best) {
        await bumpHit(best.row.id, ctx).catch((err: unknown) =>
          logger.debug(
            { err, cacheId: best.row.id },
            "cache: bumpHit failed (non-fatal)",
          ),
        );
        const usage = toUsage(best.row.usage);
        emitCacheEvent(ctx, "hit", {
          semantic: true,
          similarity: best.similarity,
          saved: usage,
        });
        return {
          hit: {
            value: best.row.response as T,
            usage,
            kind: best.row.responseKind as CachedResponseKind,
            semantic: true,
            similarity: best.similarity,
          },
          queryEmbedding,
        };
      }

      emitCacheEvent(ctx, "miss", { semantic: true, similarity: 0 });
      return { hit: null, queryEmbedding };
    });
  } catch (err) {
    // A cache read must never fail the underlying LLM call — treat as a miss.
    logger.error({ err }, "cache read failed");
    return { hit: null };
  }
}

/**
 * Write a fresh result into the cache. Upserts on the (org, workspace,
 * cache_key) unique key so a re-computed value refreshes the entry (and its
 * TTL). Best-effort — a write failure must never fail the caller.
 */
export async function writeCache(
  ctx: CacheContext,
  options: CacheOptions,
  value: unknown,
  usage: CachedUsage,
  kind: CachedResponseKind = "object",
  precomputedEmbedding?: number[],
): Promise<void> {
  const cacheKey = buildCacheKey(ctx);
  const scope: TenantScope = getScope() ?? {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
  const expiresAt = new Date(Date.now() + options.ttlSeconds * 1000);

  try {
    // Compute the embedding for the semantic layer if it wasn't already done in
    // the read path. Skip entirely when semantic is off.
    let embedding: number[] | null = null;
    if (options.semantic) {
      embedding =
        precomputedEmbedding ??
        (await embedText(ctx.promptText, {
          telemetry: {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            surface: ctx.surface,
            executionStepId: null,
          },
        }));
    }

    await runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        await tx
          .insert(schema.aiResponseCache)
          .values({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            cacheKey,
            promptHash: ctx.promptHash,
            model: ctx.model,
            surface: ctx.surface,
            responseKind: kind,
            response: value as object,
            usage: usage as object,
            embedding: embedding as object | null,
            expiresAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.aiResponseCache.orgId,
              schema.aiResponseCache.workspaceId,
              schema.aiResponseCache.cacheKey,
            ],
            // Match the PARTIAL unique index (WHERE deleted_at IS NULL).
            targetWhere: isNull(schema.aiResponseCache.deletedAt),
            set: {
              response: value as object,
              usage: usage as object,
              embedding: embedding as object | null,
              expiresAt,
              updatedAt: new Date(),
            },
          });
      }),
    );
  } catch (err) {
    // A cache write must never fail the caller.
    logger.error({ err }, "cache write failed");
  }
}

/** Increment hit_count / last_hit_at for a served entry. Best-effort. */
async function bumpHit(id: string, ctx: CacheContext): Promise<void> {
  const scope: TenantScope = getScope() ?? {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
  await runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      await tx
        .update(schema.aiResponseCache)
        .set({
          hitCount: sql`${schema.aiResponseCache.hitCount} + 1`,
          lastHitAt: new Date(),
        })
        .where(eq(schema.aiResponseCache.id, id));
    }),
  );
}
