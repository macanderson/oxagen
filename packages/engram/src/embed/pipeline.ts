/**
 * Embedding pipeline — generates vector embeddings for memory records.
 *
 * Called asynchronously by the Inngest worker after a record is written.
 * The embedding is stored back on the record for vector retrieval.
 */
import { quantizeToInt8 } from "./quantize";

export interface EmbedResult {
  recordId: string;
  /** Full float32 vector for Neo4j ANN index. */
  embedding: number[];
  /** Int8 quantized vector for local storage. */
  quantized: Int8Array;
  /**
   * Reconstruction scale for {@link quantized} (`float ≈ int8 / scale`). Must
   * be persisted alongside the bytes — without it the quantized vector cannot
   * be dequantized correctly for local cosine similarity.
   */
  quantizationScale: number;
}

export interface EmbedOpts {
  orgId: string;
  workspaceId: string;
  surface: string;
}

/**
 * Extract text suitable for embedding from a record body.
 * Different record kinds have different text representations.
 */
export function extractEmbeddingText(kind: string, body: unknown): string {
  const b = body as Record<string, unknown>;
  switch (kind) {
    case "episodic": {
      const event = (b.event as string) ?? "";
      const payload = b.payload;
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      return `${event}: ${payloadStr}`.slice(0, 2000);
    }
    case "semantic":
      return (b.fact as string) ?? JSON.stringify(b).slice(0, 2000);
    case "procedural":
      return (b.rule as string) ?? JSON.stringify(b).slice(0, 2000);
    case "entity":
      return `${b.entityType ?? ""} ${b.name ?? ""}`.trim() || JSON.stringify(b).slice(0, 2000);
    case "edge":
      return `${b.edgeType ?? ""}: ${b.sourceId ?? ""} → ${b.targetId ?? ""}`;
    default:
      return JSON.stringify(b).slice(0, 2000);
  }
}

/**
 * Generate an embedding for a record. Requires `embedTextFn` to be injected
 * so this module doesn't hard-depend on `@oxagen/ai` at the package level.
 */
export async function embedRecord(
  recordId: string,
  kind: string,
  body: unknown,
  embedTextFn: (text: string) => Promise<number[]>,
): Promise<EmbedResult> {
  const text = extractEmbeddingText(kind, body);
  const embedding = await embedTextFn(text);
  const { quantized, scale } = quantizeToInt8(embedding);
  return { recordId, embedding, quantized, quantizationScale: scale };
}
