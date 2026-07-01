/**
 * Shared code-graph embedding contract — the ONE place the code-graph vector
 * model, dimension, and similarity math are defined.
 *
 * Every vector index in the platform is 1536-d `text-embedding-3-small` / cosine
 * (see `packages/ontology/src/schema.cypher`; the universal index is
 * `graph_node_embedding_index`). Both consumers of the code graph — the server
 * ingestion pipeline (`@oxagen/ingestion`) and the local CLI daemon
 * (`apps/cli`) — MUST embed with this exact model and dimension so a graph
 * synced from the CLI stays searchable in `apps/app`, and so "semantic search"
 * behaves identically across surfaces. Import these constants instead of
 * re-pinning the literals.
 *
 * The embed *call* itself is surface-specific and stays in the consumer:
 *   - server: `@oxagen/ai`'s `embedText` (metered + billed through the gateway),
 *   - CLI: a thin gateway client keyed by `AI_GATEWAY_API_KEY`.
 * Only the model contract and the pure similarity math live here.
 *
 * Module: @oxagen/code-graph/embed
 */

/**
 * The Vercel AI Gateway model id for code-graph embeddings. Passed to
 * `gateway.textEmbeddingModel(...)` / `embed(...)`. Kept in lockstep with
 * `@oxagen/ai`'s `GATEWAY_MODEL` — the two describe the same pinned model.
 */
export const CODE_EMBED_GATEWAY_MODEL = "openai/text-embedding-3-small";

/** The logical model id used for cost/telemetry labelling (no `openai/` prefix). */
export const CODE_EMBED_MODEL = "text-embedding-3-small";

/**
 * Vector dimension of {@link CODE_EMBED_MODEL}. Every Neo4j vector index is
 * declared with this dimension; an embedding of any other length is rejected at
 * the sync boundary rather than corrupting the index.
 */
export const CODE_EMBED_DIM = 1536;

/** True when a vector is a finite, correctly-dimensioned code-graph embedding. */
export function isValidCodeEmbedding(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === CODE_EMBED_DIM &&
    vector.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 for a
 * length mismatch or a zero-magnitude vector rather than throwing or emitting
 * NaN, so a ranking loop never has to special-case degenerate inputs.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
