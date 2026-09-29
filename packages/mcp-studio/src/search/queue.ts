// queue.ts: send search entries to the embedder in batches, one batch at a
// time (lane M15; ADR-217).
//
// A publish can change hundreds of entries, and several searches can ask for
// the same entries at once. The queue cuts the texts into batches and sends
// one batch at a time, so one index never holds more than one document
// request open at its provider. A failed batch fails its caller only. The
// next batch still runs.
import type { Embedder } from "./embedder";

/** The most entries one embeddings request carries. Voyage AI takes 1,000. */
export const EMBED_BATCH_SIZE = 128;

export class EmbeddingQueue {
  private readonly embedder: Embedder;
  private readonly batchSize: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(embedder: Embedder, batchSize: number = EMBED_BATCH_SIZE) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("A batch holds at least one entry.");
    this.embedder = embedder;
    this.batchSize = batchSize;
  }

  /** One document vector per text, in the order given. */
  async documents(texts: readonly string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      vectors.push(...(await this.enqueue(() => this.embedder.embed(batch, "document"))));
    }
    return vectors;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
