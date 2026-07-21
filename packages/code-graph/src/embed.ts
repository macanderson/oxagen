/**
 * Local code-graph embedding contract — the one place the checkout graph's
 * vector model, dimension, and similarity math are defined.
 *
 * The exact code graph stays beside the checkout/worktree and is never synced
 * into the Oxagen workspace graph. Local consumers import these constants
 * instead of re-pinning model literals so a single graph generation remains
 * internally consistent.
 *
 * The embed call stays in the local client; only the model contract and pure
 * similarity math live here.
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
 * Vector dimension of {@link CODE_EMBED_MODEL}. A local index rejects any other
 * length rather than mixing incompatible graph generations.
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
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
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
