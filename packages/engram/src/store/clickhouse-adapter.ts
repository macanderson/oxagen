/**
 * ClickHouse episodic store adapter.
 *
 * Used for cloud/production deployments. ClickHouse provides excellent
 * append-only write performance and analytical query capabilities at scale.
 * Uses ReplacingMergeTree for natural deduplication by record ID.
 */
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { MemoryRecord, Namespace, RecordKind } from "../types";
import type { EpisodicQuery, EpisodicStore } from "./episodic";
import { tokenizeLexicalQuery } from "./lexical-tokenize";

export interface ClickHouseAdapterOpts {
  url: string;
  username: string;
  password: string;
  database: string;
}

/**
 * Serialize a MemoryRecord into a row object for ClickHouse insert.
 */
function recordToRow(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    namespace_org: record.namespace.org,
    namespace_workspace: record.namespace.workspace,
    namespace_session: record.namespace.session ?? "",
    namespace_agent: record.namespace.agent ?? "",
    body: JSON.stringify(record.body),
    embedding: record.embedding
      ? // Respect byteOffset/byteLength so a subarray view over a larger buffer
        // serializes only its own window, not the whole backing ArrayBuffer.
        Buffer.from(
          record.embedding.buffer,
          record.embedding.byteOffset,
          record.embedding.byteLength,
        ).toString("base64")
      : "",
    salience: record.salience,
    confidence: record.confidence,
    provenance: JSON.stringify(record.provenance),
    causality: JSON.stringify(record.causality),
    ttl: record.ttl ?? 0,
    created_at: record.createdAt,
  };
}

/**
 * Deserialize a ClickHouse row back into a MemoryRecord.
 */
function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const embeddingStr = row["embedding"] as string;
  let embedding: Int8Array | undefined;
  if (embeddingStr) {
    embedding = new Int8Array(Buffer.from(embeddingStr, "base64"));
  }

  const sessionVal = row["namespace_session"] as string;
  const agentVal = row["namespace_agent"] as string;

  return {
    id: row["id"] as string,
    kind: row["kind"] as RecordKind,
    namespace: {
      org: row["namespace_org"] as string,
      workspace: row["namespace_workspace"] as string,
      session: sessionVal || undefined,
      agent: agentVal || undefined,
    },
    body: JSON.parse(row["body"] as string) as unknown,
    embedding,
    salience: Number(row["salience"]),
    confidence: Number(row["confidence"]),
    provenance: JSON.parse(
      row["provenance"] as string,
    ) as MemoryRecord["provenance"],
    causality: JSON.parse(row["causality"] as string) as string[],
    ttl: (row["ttl"] as number) || undefined,
    createdAt: Number(row["created_at"]),
  };
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS engram_episodic_records (
    id              String,
    kind            LowCardinality(String),
    namespace_org   String,
    namespace_workspace String,
    namespace_session   String DEFAULT '',
    namespace_agent     String DEFAULT '',
    body            String,
    embedding       String DEFAULT '',
    salience        Float64,
    confidence      Float64,
    provenance      String,
    causality       String,
    ttl             UInt64 DEFAULT 0,
    created_at      UInt64,
    -- Skip index for lexical search. searchLexical() matches lowercased
    -- substrings via position(lower(body), token); an ngram bloom filter over
    -- lower(body) lets ClickHouse prune granules that can't contain the token
    -- instead of full-scanning the partition. ngram (not token) because the
    -- search is substring-based and keeps path/identifier tokens glued
    -- (e.g. "auth.ts:42").
    INDEX idx_body_ngram lower(body) TYPE ngrambf_v1(3, 65536, 3, 0) GRANULARITY 4
  )
  ENGINE = ReplacingMergeTree()
  PARTITION BY (namespace_org, toYYYYMM(fromUnixTimestamp64Milli(created_at)))
  ORDER BY (namespace_org, namespace_workspace, created_at, id)
`;

/**
 * ClickHouse-backed episodic store implementation.
 */
export class ClickHouseEpisodicStore implements EpisodicStore {
  private client: ClickHouseClient;
  private ready: Promise<void>;

  constructor(opts: ClickHouseAdapterOpts) {
    this.client = createClient({
      url: opts.url,
      username: opts.username,
      password: opts.password,
      database: opts.database,
      clickhouse_settings: {
        date_time_input_format: "best_effort",
      },
    });
    this.ready = this.initialize();

    // The store is opened eagerly (e.g. at CLI/runtime startup) but awaited only
    // lazily on first use. If ClickHouse is unreachable, `initialize()` rejects
    // with a connection error (ECONNREFUSED) while nothing is awaiting `ready`,
    // which would otherwise surface as an *unhandled* rejection and crash the
    // host process. Attach a no-op catch so the rejection never escapes; real
    // consumers still observe it via their own `await this.ready` and degrade to
    // best-effort. Mirrors the DuckDB adapter's guard.
    void this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    await this.client.command({ query: CREATE_TABLE_SQL });
  }

  async append(record: MemoryRecord): Promise<void> {
    await this.ready;
    await this.client.insert({
      table: "engram_episodic_records",
      values: [recordToRow(record)],
      format: "JSONEachRow",
    });
  }

  async appendBatch(records: MemoryRecord[]): Promise<void> {
    await this.ready;
    if (records.length === 0) return;
    await this.client.insert({
      table: "engram_episodic_records",
      values: records.map(recordToRow),
      format: "JSONEachRow",
    });
  }

  async query(opts: EpisodicQuery): Promise<MemoryRecord[]> {
    await this.ready;

    const conditions: string[] = [
      "namespace_org = {org:String}",
      "namespace_workspace = {workspace:String}",
    ];
    const params: Record<string, unknown> = {
      org: opts.namespace.org,
      workspace: opts.namespace.workspace,
    };

    if (opts.namespace.session) {
      conditions.push("namespace_session = {session:String}");
      params["session"] = opts.namespace.session;
    }
    if (opts.namespace.agent) {
      conditions.push("namespace_agent = {agent:String}");
      params["agent"] = opts.namespace.agent;
    }
    if (opts.after !== undefined) {
      conditions.push("created_at > {after:UInt64}");
      params["after"] = opts.after;
    }
    if (opts.before !== undefined) {
      conditions.push("created_at < {before:UInt64}");
      params["before"] = opts.before;
    }
    if (opts.kinds && opts.kinds.length > 0) {
      conditions.push("kind IN ({kinds:Array(String)})");
      params["kinds"] = opts.kinds;
    }
    if (opts.minSalience !== undefined) {
      conditions.push("salience >= {minSalience:Float64}");
      params["minSalience"] = opts.minSalience;
    }

    // FINAL retained: query() feeds the pinned-rule lookup and temporal engine,
    // where an un-merged duplicate row would list the same rule/record twice and
    // return a stale salience (reinforcement re-inserts the same key). These are
    // bounded (LIMIT + salience filter) reads, so merge-on-read is affordable.
    const sql = `
      SELECT * FROM engram_episodic_records FINAL
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;
    params["limit"] = opts.limit;
    params["offset"] = opts.offset ?? 0;

    const result = await this.client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });

    const rows = (await result.json()) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    await this.ready;
    // FINAL retained: a single-row point lookup must return the merged/latest
    // version. Without it, LIMIT 1 could pick a stale duplicate (e.g. pre-
    // reinforcement salience). Cheap — it's one key.
    const result = await this.client.query({
      query:
        "SELECT * FROM engram_episodic_records FINAL WHERE id = {id:String} LIMIT 1",
      query_params: { id },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]!);
  }

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    await this.ready;
    if (ids.length === 0) return [];
    // No FINAL: this is a hot fan-in read. Un-merged duplicate rows are harmless
    // here — every caller (the retrieval engines) builds a Map keyed by record
    // id from the result, so a duplicate collapses. Skipping the merge-on-read
    // avoids a large cost on the batch lookup path.
    const result = await this.client.query({
      query:
        "SELECT * FROM engram_episodic_records WHERE id IN ({ids:Array(String)})",
      query_params: { ids },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  async recent(
    namespace: Namespace,
    limit: number,
    minSalience?: number,
  ): Promise<MemoryRecord[]> {
    return this.query({ namespace, limit, minSalience });
  }

  async searchLexical(
    namespace: Namespace,
    query: string,
    limit: number,
  ): Promise<Array<{ recordId: string; score: number }>> {
    await this.ready;
    const tokens = tokenizeLexicalQuery(query);
    if (tokens.length === 0 || limit <= 0) return [];

    // Same term-frequency scoring as the DuckDB adapter (see
    // lexical-tokenize.ts): each matched token contributes 1/tokens.length.
    // positionCaseInsensitive() returns the 1-based match position or 0 —
    // ClickHouse's tokenbf_v1-friendly equivalent of DuckDB's contains().
    const tokenParams: Record<string, string> = {};
    tokens.forEach((t, i) => {
      tokenParams[`tok${i}`] = t;
    });
    // Match against lower(body) with already-lowercased tokens (equivalent to
    // positionCaseInsensitive) so the predicate lines up with the
    // `lower(body)` ngram skip index and ClickHouse can prune granules instead
    // of full-scanning.
    const matchExprs = tokens.map(
      (_, i) => `if(position(lower(body), {tok${i}:String}) > 0, 1, 0)`,
    );
    const scoreSql = `(${matchExprs.join(" + ")}) / ${tokens.length}.0`;
    const whereOr = tokens
      .map((_, i) => `position(lower(body), {tok${i}:String}) > 0`)
      .join(" OR ");

    // No FINAL: search returns (id, score); duplicate rows would just repeat an
    // id, and callers dedupe by id when fetching full records via getByIds.
    // Skipping merge-on-read is the whole point of adding the skip index.
    const sql = `
      SELECT id, ${scoreSql} AS lexical_score
      FROM engram_episodic_records
      WHERE namespace_org = {org:String} AND namespace_workspace = {workspace:String}
        AND (${whereOr})
      ORDER BY lexical_score DESC
      LIMIT {limit:UInt32}
    `;

    const result = await this.client.query({
      query: sql,
      query_params: {
        ...tokenParams,
        org: namespace.org,
        workspace: namespace.workspace,
        limit,
      },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Record<string, unknown>[];
    return rows.map((r) => ({
      recordId: r["id"] as string,
      score: Number(r["lexical_score"] ?? 0),
    }));
  }

  async listNamespaces(): Promise<Namespace[]> {
    await this.ready;
    const result = await this.client.query({
      query:
        "SELECT DISTINCT namespace_org, namespace_workspace FROM engram_episodic_records",
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Record<string, unknown>[];
    return rows.map((r) => ({
      org: r["namespace_org"] as string,
      workspace: r["namespace_workspace"] as string,
    }));
  }

  async updateSalience(id: string, salience: number): Promise<void> {
    await this.reinsertWith(id, (row) => ({ ...row, salience }));
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    await this.reinsertWith(id, (row) => ({ ...row, confidence }));
  }

  /**
   * ReplacingMergeTree "update": re-insert the full row (same sort key) with a
   * mutated field. A later `SELECT ... FINAL` returns the newest version, so an
   * in-place UPDATE isn't needed — and a full-row re-insert is far cheaper than
   * an `ALTER TABLE ... UPDATE` mutation for a per-record nightly job.
   */
  private async reinsertWith(
    id: string,
    mutate: (row: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await this.ready;
    const record = await this.getById(id);
    if (!record) return;
    await this.client.insert({
      table: "engram_episodic_records",
      values: [mutate(recordToRow(record))],
      format: "JSONEachRow",
    });
  }

  async evictExpired(namespace: Namespace, now: number): Promise<number> {
    await this.ready;
    const where =
      "namespace_org = {org:String} AND namespace_workspace = {workspace:String} AND ttl > 0 AND ttl <= {now:UInt64}";
    const params = { org: namespace.org, workspace: namespace.workspace, now };
    const countRes = await this.client.query({
      query: `SELECT count() AS n FROM engram_episodic_records FINAL WHERE ${where}`,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = (await countRes.json()) as Array<{ n: string | number }>;
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) {
      // Lightweight DELETE (ClickHouse ≥ 22.8) — a nightly TTL sweep, not a hot path.
      await this.client.command({
        query: `DELETE FROM engram_episodic_records WHERE ${where}`,
        query_params: params,
      });
    }
    return n;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
