/**
 * embedding-types.ts — the embedding port, as a dependency-free leaf.
 *
 * Shared by the resolver (embedding.ts) and the provider implementations
 * (embedding-ollama.ts, embedding-onnx.ts). Extracted so providers can
 * type-depend on the port without importing the resolver — which
 * value-imports the providers back (that was a 3-file import cycle).
 */

/** A backend that turns text into `CODE_EMBED_DIM`-d vectors. Injectable for tests. */
export interface EmbeddingClient {
  /** The provider id stored alongside each vector so a model swap re-embeds. */
  readonly providerId: string;
  /** Vector dimension — always CODE_EMBED_DIM (see @oxagen/code-graph/embed) for the code graph. */
  readonly dimensions: number;
  /** Embed one text. */
  embed(text: string): Promise<number[]>;
  /** Embed many texts in one round-trip (order-preserving). */
  embedBatch(texts: string[]): Promise<number[][]>;
}
