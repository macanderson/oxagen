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
import { tokenizeLexicalQuery } from "./lexical-tokenize";
import { NativeModuleUnavailableError } from "./errors";

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
    record.embedding
      ? // Honor the view's byteOffset/byteLength — an Int8Array can be a window
        // over a larger ArrayBuffer (e.g. a subarray), and Buffer.from(buf)
        // alone would serialize the whole backing buffer, corrupting the value.
        Buffer.from(
          record.embedding.buffer,
          record.embedding.byteOffset,
          record.embedding.byteLength,
        ).toString("base64")
      : null,
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
    provenance: JSON.parse(
      row["provenance"] as string,
    ) as MemoryRecord["provenance"],
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
    // duckdb is an optional native (CJS) module. Guard the synchronous require
    // so a missing binary degrades to a clear, typed error at construction
    // (createStore) time instead of an opaque MODULE_NOT_FOUND that takes down
    // the caller with no hint that the fix is installing the optional dep.
    let duckdb: typeof import("duckdb");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- duckdb uses CJS
      duckdb = require("duckdb") as typeof import("duckdb");
    } catch (err) {
      throw new NativeModuleUnavailableError("duckdb", err);
    }
    this.db = new duckdb.Database(opts.path);
    this.conn = this.db.connect();
    this.ready = this.initialize();
    // DuckDB opens the file as a single writer. If another oxagen process (the
    // context daemon, or a second TUI) already holds it, the connection can't be
    // established and `initialize()` rejects with a DUCKDB_NODEJS_ERROR
    // ("Connection was never established or has been closed already"). Attach a
    // no-op catch so that rejection never escapes as an *unhandled* promise
    // rejection that crashes the host process — every consumer still observes it
    // via its own `await this.ready` and degrades to best-effort (memory off).
    void this.ready.catch(() => {});
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

  private querySql(
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      this.conn.all(
        sql,
        ...params,
        (err: Error | null, rows: Record<string, unknown>[]) => {
          if (err) reject(err);
          else resolve(rows ?? []);
        },
      );
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

  async searchLexical(
    namespace: Namespace,
    query: string,
    limit: number,
  ): Promise<Array<{ recordId: string; score: number }>> {
    await this.ready;
    const tokens = tokenizeLexicalQuery(query);
    if (tokens.length === 0 || limit <= 0) return [];

    // Term-frequency score: each matched token contributes 1/tokens.length,
    // so a record matching every query token scores 1.0. `contains()` is a
    // case-sensitive substring test — both the body and the tokens are
    // lowercased first to make this case-insensitive lexical matching.
    const matchExprs = tokens.map(
      () => "CASE WHEN contains(lower_body, ?) THEN 1 ELSE 0 END",
    );
    const scoreSql = `(${matchExprs.join(" + ")}) / ${tokens.length}.0`;
    const whereOr = tokens.map(() => "contains(lower_body, ?)").join(" OR ");

    const sql = `
      SELECT id, ${scoreSql} AS lexical_score
      FROM (
        SELECT id, lower(CAST(body AS VARCHAR)) AS lower_body
        FROM episodic_records
        WHERE namespace_org = ? AND namespace_workspace = ?
      ) t
      WHERE ${whereOr}
      ORDER BY lexical_score DESC
      LIMIT ?
    `;
    const params = [
      ...tokens,
      namespace.org,
      namespace.workspace,
      ...tokens,
      limit,
    ];

    const rows = await this.querySql(sql, params);
    return rows.map((r) => ({
      recordId: r["id"] as string,
      score: Number(r["lexical_score"] ?? 0),
    }));
  }

  async listNamespaces(): Promise<Namespace[]> {
    await this.ready;
    const rows = await this.querySql(
      `SELECT DISTINCT namespace_org, namespace_workspace FROM episodic_records`,
    );
    return rows.map((r) => ({
      org: r["namespace_org"] as string,
      workspace: r["namespace_workspace"] as string,
    }));
  }

  async updateSalience(id: string, salience: number): Promise<void> {
    await this.ready;
    await this.runSql(`UPDATE episodic_records SET salience = ? WHERE id = ?`, [
      salience,
      id,
    ]);
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    await this.ready;
    await this.runSql(
      `UPDATE episodic_records SET confidence = ? WHERE id = ?`,
      [confidence, id],
    );
  }

  async evictExpired(namespace: Namespace, now: number): Promise<number> {
    await this.ready;
    const where = `namespace_org = ? AND namespace_workspace = ? AND ttl IS NOT NULL AND ttl > 0 AND ttl <= ?`;
    const params = [namespace.org, namespace.workspace, now];
    // Count first (DuckDB's run() doesn't return an affected-row count).
    const rows = await this.querySql(
      `SELECT count(*) AS n FROM episodic_records WHERE ${where}`,
      params,
    );
    const n = Number(rows[0]?.["n"] ?? 0);
    if (n > 0) {
      await this.runSql(`DELETE FROM episodic_records WHERE ${where}`, params);
    }
    return n;
  }

  async close(): Promise<void> {
    // Ensure initialization has settled before tearing down so that native
    // DuckDB callbacks don't fire on a closed connection.
    await this.ready.catch(() => {});
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
