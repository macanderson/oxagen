/**
 * DuckDB episodic store adapter.
 *
 * Used for local development and CLI. DuckDB gives sub-millisecond
 * append latency and excellent analytical query performance. The store
 * is backed by a file on disk (or in-memory for tests).
 */
import type { Database, Connection } from "duckdb";
import type { MemoryRecord, Namespace, RecordKind } from "../types";
import type { EpisodicQuery, EpisodicStore } from "./episodic";

/**
 * Serialize a MemoryRecord into column values for DuckDB insert.
 */
function recordToRow(record: MemoryRecord): unknown[] {
  return [
    record.id,
    record.kind,
    record.namespace.org,
    record.namespace.workspace,
    record.namespace.session ?? null,
    record.namespace.agent ?? null,
    JSON.stringify(record.body),
    record.embedding ? Buffer.from(record.embedding.buffer).toString("base64") : null,
    record.salience,
    record.confidence,
    JSON.stringify(record.provenance),
    JSON.stringify(record.causality),
    record.ttl ?? null,
    record.createdAt,
  ];
}

/**
 * Deserialize a DuckDB row back into a MemoryRecord.
 */
function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const embeddingStr = row["embedding"] as string | null;
  let embedding: Int8Array | undefined;
  if (embeddingStr) {
    embedding = new Int8Array(Buffer.from(embeddingStr, "base64"));
  }

  return {
    id: row["id"] as string,
    kind: row["kind"] as RecordKind,
    namespace: {
      org: row["namespace_org"] as string,
      workspace: row["namespace_workspace"] as string,
      session: (row["namespace_session"] as string | null) ?? undefined,
      agent: (row["namespace_agent"] as string | null) ?? undefined,
    },
    body: JSON.parse(row["body"] as string) as unknown,
    embedding,
    salience: row["salience"] as number,
    confidence: row["confidence"] as number,
    provenance: JSON.parse(row["provenance"] as string) as MemoryRecord["provenance"],
    causality: JSON.parse(row["causality"] as string) as string[],
    ttl: (row["ttl"] as number | null) ?? undefined,
    createdAt: row["created_at"] as number,
  };
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episodic_records (
    id              VARCHAR(64) PRIMARY KEY,
    kind            VARCHAR(16) NOT NULL,
    namespace_org   VARCHAR NOT NULL,
    namespace_workspace VARCHAR NOT NULL,
    namespace_session   VARCHAR,
    namespace_agent     VARCHAR,
    body            JSON NOT NULL,
    embedding       VARCHAR,
    salience        DOUBLE NOT NULL,
    confidence      DOUBLE NOT NULL,
    provenance      JSON NOT NULL,
    causality       JSON NOT NULL,
    ttl             BIGINT,
    created_at      BIGINT NOT NULL
  )
`;

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodic_ns_created
  ON episodic_records (namespace_org, namespace_workspace, created_at DESC)
`;

export interface DuckDBAdapterOpts {
  /** Path to the DuckDB database file. Use `:memory:` for tests. */
  path: string;
}

/**
 * DuckDB-backed episodic store implementation.
 */
export class DuckDBEpisodicStore implements EpisodicStore {
  private db: Database;
  private conn: Connection;
  private ready: Promise<void>;

  constructor(opts: DuckDBAdapterOpts) {
    // Dynamic import pattern — duckdb is a native module and we lazy-load
    // to avoid hard dependency issues in environments where it's not needed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- duckdb uses CJS
    const duckdb = require("duckdb") as typeof import("duckdb");
    this.db = new duckdb.Database(opts.path);
    this.conn = this.db.connect();
    this.ready = this.initialize();
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.run(CREATE_TABLE_SQL, (err) => {
        if (err) return reject(err);
        this.conn.run(INDEX_SQL, (err2) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }

  private runSql(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.run(sql, ...params, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private querySql(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, ...params, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }

  async append(record: MemoryRecord): Promise<void> {
    await this.ready;
    const values = recordToRow(record);
    await this.runSql(
      `INSERT OR IGNORE INTO episodic_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
    );
  }

  async appendBatch(records: MemoryRecord[]): Promise<void> {
    await this.ready;
    if (records.length === 0) return;

    // Use a transaction for batch performance
    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const record of records) {
        const values = recordToRow(record);
        await this.runSql(
          `INSERT OR IGNORE INTO episodic_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  async query(opts: EpisodicQuery): Promise<MemoryRecord[]> {
    await this.ready;

    const conditions: string[] = [
      "namespace_org = ?",
      "namespace_workspace = ?",
    ];
    const params: unknown[] = [opts.namespace.org, opts.namespace.workspace];

    if (opts.namespace.session) {
      conditions.push("namespace_session = ?");
      params.push(opts.namespace.session);
    }
    if (opts.namespace.agent) {
      conditions.push("namespace_agent = ?");
      params.push(opts.namespace.agent);
    }
    if (opts.after !== undefined) {
      conditions.push("created_at > ?");
      params.push(opts.after);
    }
    if (opts.before !== undefined) {
      conditions.push("created_at < ?");
      params.push(opts.before);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      conditions.push(`kind IN (${placeholders})`);
      params.push(...opts.kinds);
    }
    if (opts.minSalience !== undefined) {
      conditions.push("salience >= ?");
      params.push(opts.minSalience);
    }

    params.push(opts.limit);
    params.push(opts.offset ?? 0);

    const sql = `
      SELECT * FROM episodic_records
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = await this.querySql(sql, params);
    return rows.map(rowToRecord);
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    await this.ready;
    const rows = await this.querySql(
      "SELECT * FROM episodic_records WHERE id = ?",
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]!);
  }

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    await this.ready;
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.querySql(
      `SELECT * FROM episodic_records WHERE id IN (${placeholders})`,
      ids,
    );
    return rows.map(rowToRecord);
  }

  async recent(
    namespace: Namespace,
    limit: number,
    minSalience?: number,
  ): Promise<MemoryRecord[]> {
    return this.query({
      namespace,
      limit,
      minSalience,
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.close((err) => {
        if (err) return reject(err);
        this.db.close((err2) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }
}
