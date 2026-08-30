/**
 * embedding-types.ts — the embedding port, as a dependency-free leaf.
 *
 * Shared by the resolver (embedding.ts) and the provider implementations
 * (embedding-ollama.ts, embedding-onnx.ts). Extracted so providers can
 * type-depend on the port without importing the resolver — which
 * value-imports the providers back (that was a 3-file import cycle).
 */

/** A backend that turns text into fixed-width vectors. Injectable for tests. */
export interface EmbeddingClient {
  /** The provider id stored alongside each vector so a model swap re-embeds. */
  readonly providerId: string;
  /**
   * Vector width for THIS provider — it is not one number across providers.
   * The gateway client is `CODE_EMBED_DIM` (1536, see @oxagen/code-graph/embed),
   * ONNX/bge-small is 384, and Ollama's is whatever the local model returns
   * (768 for `nomic-embed-text`). Vectors from different providers live in
   * different spaces and are never compared — {@link providerId} is the key
   * that keeps them apart.
   */
  readonly dimensions: number;
  /** Embed one text. */
  embed(text: string): Promise<number[]>;
  /** Embed many texts in one round-trip (order-preserving). */
  embedBatch(texts: string[]): Promise<number[][]>;
}
