// fakes.ts: an Embedder and a SearchIndexStore in memory, for the search
// index's tests.
import type { EmbedPurpose, Embedder } from "../embedder";
import type { SearchIndexStore, StoredVector } from "../search-index";

export interface EmbedCall {
  texts: string[];
  purpose: EmbedPurpose;
}

export interface FakeEmbedder extends Embedder {
  calls: EmbedCall[];
}

/**
 * An Embedder that gives each text the vector `vectorOf` returns. By default
 * a text's vector counts the words it shares with each axis.
 */
export function fakeEmbedder(
  vectorOf: (text: string, purpose: EmbedPurpose) => number[] | Promise<number[]>,
  key = "k".repeat(32),
): FakeEmbedder {
  const calls: EmbedCall[] = [];
  return {
    key,
    calls,
    async embed(texts, purpose) {
      calls.push({ texts: [...texts], purpose });
      const vectors: Float32Array[] = [];
      for (const text of texts) vectors.push(new Float32Array(await vectorOf(text, purpose)));
      return vectors;
    },
  };
}

/** A vector with one axis per word: 1 where the text holds the word. */
export function axes(words: readonly string[]): (text: string) => number[] {
  return (text) => {
    const lower = text.toLowerCase();
    return words.map((word) => (lower.includes(word) ? 1 : 0));
  };
}

export interface MemoryStore extends SearchIndexStore {
  rows: Map<string, Float32Array>;
  reads: Array<{ key: string; hashes: string[] }>;
  writes: Array<{ key: string; rows: StoredVector[] }>;
}

/** A SearchIndexStore in a Map keyed by target key and hash. */
export function memoryStore(): MemoryStore {
  const rows = new Map<string, Float32Array>();
  const reads: MemoryStore["reads"] = [];
  const writes: MemoryStore["writes"] = [];
  return {
    rows,
    reads,
    writes,
    read(key, hashes) {
      reads.push({ key, hashes: [...hashes] });
      const found: StoredVector[] = [];
      for (const hash of hashes) {
        const vector = rows.get(`${key}:${hash}`);
        if (vector !== undefined) found.push({ hash, vector });
      }
      return Promise.resolve(found);
    },
    write(key, written) {
      writes.push({ key, rows: [...written] });
      for (const row of written) if (!rows.has(`${key}:${row.hash}`)) rows.set(`${key}:${row.hash}`, row.vector);
      return Promise.resolve();
    },
  };
}
