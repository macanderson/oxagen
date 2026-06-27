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
      ? Buffer.from(record.embedding.buffer).toString("base64")
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
    created_at      UInt64
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
    const result = await this.client.query({
      query:
        "SELECT * FROM engram_episodic_records FINAL WHERE id IN ({ids:Array(String)})",
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

  async close(): Promise<void> {
    await this.client.close();
  }
}
