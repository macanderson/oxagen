/**
 * DuckDB episodic store adapter.
 *
 * Used for local development and CLI. DuckDB gives sub-millisecond
 * append latency and excellent analytical query performance. The store
 * is backed by a file on disk (or in-memory for tests).
 */
import { createRequire } from "node:module";
import type { Database, Connection } from "duckdb";
import type { DecayStats } from "../decay";
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
    // Both are BIGINT columns, and DuckDB hands those back as JavaScript
    // BigInt. The casts these two used to carry said `number` and changed
    // nothing, so every record read from the store carried a bigint in a field
    // typed number: `new Date(createdAt)` threw "Cannot convert a BigInt value
    // to a number", and MemoryRecordSchema rejected its own stored records.
    // `toCount` is the coercion the column type has needed all along.
    ttl: toOptionalCount(row["ttl"]),
    createdAt: toCount(row["created_at"]),
    // Read back so decay's durable branch is reachable. It never was: the type
    // has carried this field since #1367 and no column held it, so every
    // record came out of the store with it undefined and decay always fell
    // back to createdAt (#1418).
    lastReinforcedAt: toOptionalCount(row["last_reinforced_at"]),
  };
}

/** DuckDB returns BIGINT as a BigInt; decay wants a number, and 0 means absent. */
function toCount(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
}

/** As above, but absent stays absent — a zero timestamp is not a timestamp. */
function toOptionalCount(value: unknown): number | undefined {
  const n = toCount(value);
  return n > 0 ? n : undefined;
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
    created_at      BIGINT NOT NULL,
    -- Durable reinforcement. These four are the ONLY columns a consolidation
    -- pass writes, and none of them is part of the content address, so
    -- reinforcing a record never changes its id (#1418).
    last_reinforced_at BIGINT,
    retrieval_count    BIGINT NOT NULL DEFAULT 0,
    success_count      BIGINT NOT NULL DEFAULT 0,
    failure_count      BIGINT NOT NULL DEFAULT 0
  )
`;

// The INSERTs below name their columns rather than relying on position. They
// did not, and adding these four broke every write with "table has 18 columns
// but 14 values were supplied" — a positional insert makes any new column a
// breaking change, which is the opposite of what a defaulted column should be.
// A database written before those four columns existed still opens, and adding
// them is the whole migration: every one is nullable or defaulted, so no row
// needs rewriting and there is nothing to undo. DuckDB has no migration
// framework here, and `IF NOT EXISTS` is what makes this safe to run at every
// open rather than once.
const ADD_COLUMN_SQL: readonly string[] = [
  `ALTER TABLE episodic_records ADD COLUMN IF NOT EXISTS last_reinforced_at BIGINT`,
  `ALTER TABLE episodic_records ADD COLUMN IF NOT EXISTS retrieval_count BIGINT DEFAULT 0`,
  `ALTER TABLE episodic_records ADD COLUMN IF NOT EXISTS success_count BIGINT DEFAULT 0`,
  `ALTER TABLE episodic_records ADD COLUMN IF NOT EXISTS failure_count BIGINT DEFAULT 0`,
];

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
    // duckdb is an optional native (CJS) module. Guard the synchronous load so
    // a missing binary degrades to a clear, typed error at construction
    // (createStore) time instead of an opaque MODULE_NOT_FOUND that takes down
    // the caller with no hint that the fix is installing the optional dep.
    //
    // Loaded through `createRequire`, not a bare `require`. This package is
    // ESM ("type": "module"), where `require` is not defined — so the bare
    // call threw `ReferenceError: require is not defined` in every real
    // process, and this catch reported it as a missing optional dependency
    // that was in fact installed. Vitest's module runner supplies a `require`,
    // so the adapter's own tests passed while nothing else could open a store
    // at all; `duckdb-adapter.esm.test.ts` is the one that runs it as a
    // separate ESM process, which is the only place the difference shows.
    let duckdb: typeof import("duckdb");
    try {
      duckdb = createRequire(import.meta.url)(
        "duckdb",
      ) as typeof import("duckdb");
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
        // Applied in order, before the index, so a database from an older
        // build has every column the queries below assume.
        const addColumns = (i: number): void => {
          if (i >= ADD_COLUMN_SQL.length) {
            this.conn.run(INDEX_SQL, (err2) => {
              if (err2) return reject(err2);
              resolve();
            });
            return;
          }
          this.conn.run(ADD_COLUMN_SQL[i]!, (errN) => {
            if (errN) return reject(errN);
            addColumns(i + 1);
          });
        };
        addColumns(0);
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
      `INSERT OR IGNORE INTO episodic_records
             (id, kind, namespace_org, namespace_workspace, namespace_session,
              namespace_agent, body, embedding, salience, confidence,
              provenance, causality, ttl, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          `INSERT OR IGNORE INTO episodic_records
             (id, kind, namespace_org, namespace_workspace, namespace_session,
              namespace_agent, body, embedding, salience, confidence,
              provenance, causality, ttl, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async updateSalience(
    id: string,
    salience: number,
    reinforcedAt?: number,
  ): Promise<void> {
    await this.ready;
    if (reinforcedAt === undefined) {
      await this.runSql(
        `UPDATE episodic_records SET salience = ? WHERE id = ?`,
        [salience, id],
      );
      return;
    }
    // Never move the timestamp backwards. A consolidation pass replaying an
    // older observation must not make a record look less recently used than
    // the store already knows it to be.
    await this.runSql(
      `UPDATE episodic_records
         SET salience = ?,
             last_reinforced_at = GREATEST(COALESCE(last_reinforced_at, 0), ?)
       WHERE id = ?`,
      [salience, reinforcedAt, id],
    );
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    await this.ready;
    await this.runSql(
      `UPDATE episodic_records SET confidence = ? WHERE id = ?`,
      [confidence, id],
    );
  }

  async reinforce(
    ids: string[],
    outcome: "success" | "failure" | null,
    at: number,
  ): Promise<void> {
    await this.ready;
    if (ids.length === 0) return;

    // One statement for the whole batch. A turn reinforces every record that
    // was in its context window, so per-id round trips would put the cost of
    // remembering on the hot path -- which is the reason this was never wired
    // to it. It is not on the hot path here either; batching keeps it cheap
    // enough that it never becomes a reason to skip.
    const placeholders = ids.map(() => "?").join(", ");
    const successDelta = outcome === "success" ? 1 : 0;
    const failureDelta = outcome === "failure" ? 1 : 0;
    await this.runSql(
      `UPDATE episodic_records
          SET retrieval_count = COALESCE(retrieval_count, 0) + 1,
              success_count   = COALESCE(success_count, 0) + ?,
              failure_count   = COALESCE(failure_count, 0) + ?,
              last_reinforced_at = GREATEST(COALESCE(last_reinforced_at, 0), ?)
        WHERE id IN (${placeholders})`,
      [successDelta, failureDelta, at, ...ids],
    );
  }

  async readDecayStats(namespace: Namespace): Promise<Map<string, DecayStats>> {
    await this.ready;
    const rows = await this.querySql(
      `SELECT id, retrieval_count, success_count, last_reinforced_at
         FROM episodic_records
        WHERE namespace_org = ? AND namespace_workspace = ?`,
      [namespace.org, namespace.workspace],
    );
    const stats = new Map<string, DecayStats>();
    for (const row of rows) {
      stats.set(row["id"] as string, {
        retrievals: toCount(row["retrieval_count"]),
        successes: toCount(row["success_count"]),
        lastRetrievedAt: toOptionalCount(row["last_reinforced_at"]),
      });
    }
    return stats;
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
