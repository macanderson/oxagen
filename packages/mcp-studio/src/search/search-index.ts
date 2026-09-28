// search-index.ts: rank a search-mode server's tools by embeddings (lane
// M15; mcp-studio-spec, Large servers; ADR-217).
//
// Each search entry's vector is stored under the workspace's target key and
// the sha256 of the entry's line. A vector is looked up in this process's
// cache first, then in the store, and only then embedded. Every index in a
// process shares one map of the vectors being embedded, so a search that
// arrives during publish's warm waits for the warm's batch instead of
// sending the same lines again. Publish warms the index, so search usually
// embeds only the query. Every failure here is a
// SearchIndexError or a store error, and the caller ranks by keyword instead.
import { contentHash } from "./entry";
import { SearchIndexError, type Embedder } from "./embedder";
import { EMBED_BATCH_SIZE, EmbeddingQueue } from "./queue";

/** One stored vector: the entry line's sha256 and its vector. */
export interface StoredVector {
  hash: string;
  vector: Float32Array;
}

/** Where a workspace's vectors are kept between processes: mcp.search_embeddings. */
export interface SearchIndexStore {
  /** The stored vectors among these hashes, under the target key. A hash with no vector is left out. */
  read(targetKey: string, hashes: readonly string[]): Promise<StoredVector[]>;
  /** Store new vectors under the target key. A hash already stored keeps its vector. */
  write(targetKey: string, rows: readonly StoredVector[]): Promise<void>;
}

/** The most vectors one process keeps in memory. 4,096 vectors of 1,024 numbers hold 16 MiB. */
export const VECTOR_CACHE_SIZE = 4096;

/** A least-recently-used cache of vectors, shared by every index in the process. */
export class VectorCache {
  private readonly entries = new Map<string, Float32Array>();
  private readonly capacity: number;

  constructor(capacity: number = VECTOR_CACHE_SIZE) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Float32Array | undefined {
    const vector = this.entries.get(key);
    if (vector !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, vector);
    }
    return vector;
  }

  set(key: string, vector: Float32Array): void {
    this.entries.delete(key);
    this.entries.set(key, vector);
    // A Map keeps insertion order, so the first keys are the least recently used.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }
}

/** How long search waits for vectors before it ranks by keyword. */
export const RANK_TIMEOUT_MS = 5_000;

/** A line for the caller's log. Fields never carry a key, a url, or a response body. */
export type SearchIndexLog = (message: string, fields: Record<string, string | number>) => void;

export interface SearchIndexOptions {
  embedder: Embedder;
  store: SearchIndexStore;
  /** A process-wide cache. Each index gets its own when none is passed. */
  cache?: VectorCache;
  /**
   * A process-wide map of the vectors being embedded now, by cache key. Each
   * index gets its own when none is passed.
   */
  pending?: Map<string, Promise<Float32Array>>;
  /** Keeps one workspace's cached vectors apart from another's: the workspace id. */
  namespace: string;
  batchSize?: number;
  rankTimeoutMs?: number;
  log?: SearchIndexLog;
}

export interface RankOptions<T> {
  /** The entry line the item is ranked by. */
  text: (item: T) => string;
  /** The name that breaks a tie, in ascending order. */
  name: (item: T) => string;
  limit: number;
}

/** A workspace's search entries under one target key. */
export class SearchIndex {
  private readonly embedder: Embedder;
  private readonly store: SearchIndexStore;
  private readonly cache: VectorCache;
  private readonly namespace: string;
  private readonly queue: EmbeddingQueue;
  private readonly rankTimeoutMs: number;
  private readonly log: SearchIndexLog | undefined;
  /** Vectors being embedded now, by cache key, so two callers that want one line send it once. */
  private readonly pending: Map<string, Promise<Float32Array>>;

  constructor(options: SearchIndexOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.cache = options.cache ?? new VectorCache();
    this.pending = options.pending ?? new Map<string, Promise<Float32Array>>();
    this.namespace = options.namespace;
    this.queue = new EmbeddingQueue(options.embedder, options.batchSize ?? EMBED_BATCH_SIZE);
    this.rankTimeoutMs = options.rankTimeoutMs ?? RANK_TIMEOUT_MS;
    this.log = options.log;
  }

  /** The target key the vectors are stored under. */
  get key(): string {
    return this.embedder.key;
  }

  /**
   * A vector for each distinct line, by the line's hash. Lines already
   * cached or stored are not embedded again. A failed store write is logged,
   * and the vectors are still returned.
   */
  async vectors(texts: readonly string[]): Promise<Map<string, Float32Array>> {
    return (await this.collect(texts)).found;
  }

  /**
   * The items most like the query, best first, at most limit of them. Ties
   * go to the name that sorts first. Throws a SearchIndexError when a vector
   * is missing or the vectors do not arrive in time.
   */
  async rank<T>(query: string, items: readonly T[], options: RankOptions<T>): Promise<T[]> {
    if (items.length === 0 || options.limit < 1) return [];
    const rows = items.map((item) => ({ item, text: options.text(item) }));
    const [documents, wanted] = await within(
      Promise.all([this.vectors(rows.map((row) => row.text)), this.queryVector(query)]),
      this.rankTimeoutMs,
    );
    const scored = rows.map(({ item, text }) => {
      const vector = documents.get(contentHash(text));
      if (vector === undefined) throw new SearchIndexError("incomplete", "A search entry has no vector. Publish again to embed it.");
      return { item, name: options.name(item), score: cosine(wanted, vector) };
    });
    scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return scored.slice(0, options.limit).map((row) => row.item);
  }

  /** Embed and store every line not already stored. Returns how many lines this call embedded. */
  async warm(texts: readonly string[]): Promise<number> {
    return (await this.collect(texts)).embedded;
  }

  private async collect(texts: readonly string[]): Promise<{ found: Map<string, Float32Array>; embedded: number }> {
    const found = new Map<string, Float32Array>();
    const missing = new Map<string, string>();
    for (const text of texts) {
      const hash = contentHash(text);
      if (found.has(hash) || missing.has(hash)) continue;
      const cached = this.cache.get(this.cacheKey("d", hash));
      if (cached === undefined) missing.set(hash, text);
      else found.set(hash, cached);
    }
    if (missing.size === 0) return { found, embedded: 0 };

    for (const row of await this.store.read(this.key, [...missing.keys()])) {
      missing.delete(row.hash);
      found.set(row.hash, row.vector);
      this.cache.set(this.cacheKey("d", row.hash), row.vector);
    }
    if (missing.size === 0) return { found, embedded: 0 };

    const waits: Array<Promise<unknown>> = [];
    const fresh: Array<[hash: string, text: string]> = [];
    for (const [hash, text] of missing) {
      const pending = this.pending.get(this.cacheKey("d", hash));
      if (pending === undefined) fresh.push([hash, text]);
      else waits.push(pending.then((vector) => found.set(hash, vector)));
    }
    let embedded = 0;
    if (fresh.length > 0) {
      waits.push(
        this.embedFresh(fresh, found).then((count) => {
          embedded = count;
        }),
      );
    }
    await Promise.all(waits);
    return { found, embedded };
  }

  private async queryVector(query: string): Promise<Float32Array> {
    const key = this.cacheKey("q", contentHash(query));
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const one = this.embedQuery(query, key);
    this.pending.set(key, one);
    try {
      return await one;
    } finally {
      this.release(key, one);
    }
  }

  private async embedQuery(query: string, key: string): Promise<Float32Array> {
    const [vector] = await this.embedder.embed([query], "query");
    if (vector === undefined) throw new SearchIndexError("incomplete", "The embeddings endpoint returned no vector for the query.");
    this.cache.set(key, vector);
    return vector;
  }

  /** Drop a pending entry, but only while it is still this call's own. */
  private release(key: string, own: Promise<Float32Array>): void {
    if (this.pending.get(key) === own) this.pending.delete(key);
  }

  /** Embed lines no one is embedding yet, store them, and return how many were embedded. */
  private async embedFresh(fresh: ReadonlyArray<[hash: string, text: string]>, found: Map<string, Float32Array>): Promise<number> {
    const batch = this.queue.documents(fresh.map(([, text]) => text));
    const owned: Array<[key: string, one: Promise<Float32Array>]> = [];
    for (const [at, [hash]] of fresh.entries()) {
      const one = batch.then((vectors) => {
        const vector = vectors[at];
        if (vector === undefined) throw new SearchIndexError("incomplete", "The embeddings endpoint returned too few vectors.");
        return vector;
      });
      // A caller that waits on this hash handles the rejection. This keeps
      // the promise from being unhandled when no caller waits.
      one.catch(() => undefined);
      const key = this.cacheKey("d", hash);
      this.pending.set(key, one);
      owned.push([key, one]);
    }
    try {
      const vectors = await batch;
      const rows: StoredVector[] = [];
      for (const [at, [hash]] of fresh.entries()) {
        const vector = vectors[at];
        if (vector === undefined) continue;
        rows.push({ hash, vector });
        found.set(hash, vector);
        this.cache.set(this.cacheKey("d", hash), vector);
      }
      try {
        await this.store.write(this.key, rows);
      } catch (error) {
        this.log?.("The search index could not store new vectors, so the next process embeds them again.", {
          errorName: error instanceof Error ? error.name : typeof error,
          count: rows.length,
        });
      }
      return rows.length;
    } finally {
      for (const [key, one] of owned) this.release(key, one);
    }
  }

  private cacheKey(kind: "d" | "q", hash: string): string {
    return `${kind}:${this.namespace}:${this.key}:${hash}`;
  }
}

/** The cosine of the angle between two vectors: 1 for the same direction. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new SearchIndexError(
      "incomplete",
      "A stored vector and the query's vector differ in length. Set [embeddings] model to the model the endpoint serves, then publish again.",
    );
  }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] ?? 0;
    const y = b[at] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** The promise's value, or a timeout error once ms pass. The promise keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SearchIndexError("timeout", "The search index did not answer in time. Search ranked by keyword."));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
