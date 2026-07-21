/**
 * GraphStore — DuckDB-backed local projection of a workspace knowledge graph.
 *
 * Stores a refreshable read-replica of the platform Neo4j workspace graph so
 * that `oxagen graph *` commands and the prompt-enhancer can answer graph
 * questions without a network round-trip.  Each workspace gets its own DuckDB
 * file (or `:memory:` in tests).
 *
 * Three tables:
 *   graph_nodes  — workspace graph nodes (upserted on pull)
 *   graph_edges  — workspace graph edges (upserted on pull)
 *   sync_cursor  — per-(org, workspace) high-watermark + counts
 */

import type { Database, Connection } from "duckdb";
import { NativeModuleUnavailableError } from "./errors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  labels: string[];
  displayName: string;
  properties: Record<string, unknown>;
  sourceId?: string;
  isSystem: boolean;
  updatedAt: string;
  org: string;
  workspace: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  inferred: boolean;
  org: string;
  workspace: string;
}

export interface SyncCursor {
  org: string;
  workspace: string;
  cursor: string;
  nodeCount: number;
  edgeCount: number;
  syncedAt: number;
}

export interface GraphStoreStats {
  nodeCount: number;
  edgeCount: number;
  cursor: string | null;
  syncedAt: number | null;
}

export interface GraphStoreOpts {
  /** Path to the DuckDB database file. Use `:memory:` for tests. */
  duckdbPath: string;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const CREATE_NODES_SQL = `
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id           VARCHAR PRIMARY KEY,
    labels       JSON    NOT NULL,
    display_name VARCHAR NOT NULL,
    properties   JSON    NOT NULL,
    source_id    VARCHAR,
    is_system    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   VARCHAR,
    org          VARCHAR NOT NULL,
    workspace    VARCHAR NOT NULL
  )
`;

const CREATE_EDGES_SQL = `
  CREATE TABLE IF NOT EXISTS graph_edges (
    id        VARCHAR PRIMARY KEY,
    source_id VARCHAR NOT NULL,
    target_id VARCHAR NOT NULL,
    type      VARCHAR NOT NULL,
    properties JSON   NOT NULL,
    inferred  BOOLEAN NOT NULL DEFAULT FALSE,
    org       VARCHAR NOT NULL,
    workspace VARCHAR NOT NULL
  )
`;

const CREATE_CURSOR_SQL = `
  CREATE TABLE IF NOT EXISTS sync_cursor (
    org        VARCHAR NOT NULL,
    workspace  VARCHAR NOT NULL,
    cursor     VARCHAR NOT NULL,
    node_count BIGINT  NOT NULL DEFAULT 0,
    edge_count BIGINT  NOT NULL DEFAULT 0,
    synced_at  BIGINT  NOT NULL,
    PRIMARY KEY (org, workspace)
  )
`;

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export class GraphStore {
  private db: Database;
  private conn: Connection;
  private ready: Promise<void>;

  constructor(opts: GraphStoreOpts) {
    // DuckDB is an optional native CJS module. Guard the synchronous require so
    // a missing binary surfaces a clear, typed error at construction instead of
    // an opaque MODULE_NOT_FOUND that crashes the caller with no remedy hint.
    let duckdb: typeof import("duckdb");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- duckdb uses CJS
      duckdb = require("duckdb") as typeof import("duckdb");
    } catch (err) {
      throw new NativeModuleUnavailableError("duckdb", err);
    }
    this.db = new duckdb.Database(opts.duckdbPath);
    this.conn = this.db.connect();
    this.ready = this.initialize();
    // Attach a no-op catch so that any early rejection never becomes an
    // unhandled promise rejection that crashes the host process — callers
    // observe it via their own awaits.
    void this.ready.catch(() => {});
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.run(CREATE_NODES_SQL, (err) => {
        if (err) return reject(err);
        this.conn.run(CREATE_EDGES_SQL, (err2) => {
          if (err2) return reject(err2);
          this.conn.run(CREATE_CURSOR_SQL, (err3) => {
            if (err3) return reject(err3);
            resolve();
          });
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

  // ---------------------------------------------------------------------------
  // Write API
  // ---------------------------------------------------------------------------

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    await this.ready;
    if (nodes.length === 0) return;

    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const n of nodes) {
        // DELETE then INSERT to achieve a full replace — avoids dialect issues
        // with INSERT OR REPLACE semantics and is guaranteed safe in DuckDB.
        await this.runSql("DELETE FROM graph_nodes WHERE id = ?", [n.id]);
        await this.runSql(
          `INSERT INTO graph_nodes
             (id, labels, display_name, properties, source_id, is_system, updated_at, org, workspace)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            n.id,
            JSON.stringify(n.labels),
            n.displayName,
            JSON.stringify(n.properties),
            n.sourceId ?? null,
            n.isSystem,
            n.updatedAt,
            n.org,
            n.workspace,
          ],
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    await this.ready;
    if (edges.length === 0) return;

    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const e of edges) {
        await this.runSql("DELETE FROM graph_edges WHERE id = ?", [e.id]);
        await this.runSql(
          `INSERT INTO graph_edges
             (id, source_id, target_id, type, properties, inferred, org, workspace)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            e.sourceId,
            e.targetId,
            e.type,
            JSON.stringify(e.properties),
            e.inferred,
            e.org,
            e.workspace,
          ],
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor
  // ---------------------------------------------------------------------------

  async getCursor(org: string, workspace: string): Promise<SyncCursor | null> {
    await this.ready;
    const rows = await this.querySql(
      "SELECT org, workspace, cursor, node_count, edge_count, synced_at FROM sync_cursor WHERE org = ? AND workspace = ?",
      [org, workspace],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      org: r["org"] as string,
      workspace: r["workspace"] as string,
      cursor: r["cursor"] as string,
      // BIGINT may come back as a JS bigint — normalise to number
      nodeCount: Number(r["node_count"]),
      edgeCount: Number(r["edge_count"]),
      syncedAt: Number(r["synced_at"]),
    };
  }

  async setCursor(
    org: string,
    workspace: string,
    cursor: string,
    nodeCount: number,
    edgeCount: number,
  ): Promise<void> {
    await this.ready;
    // Full replace of the cursor row
    await this.runSql(
      "DELETE FROM sync_cursor WHERE org = ? AND workspace = ?",
      [org, workspace],
    );
    await this.runSql(
      `INSERT INTO sync_cursor (org, workspace, cursor, node_count, edge_count, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [org, workspace, cursor, nodeCount, edgeCount, Date.now()],
    );
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  async stats(org: string, workspace: string): Promise<GraphStoreStats> {
    await this.ready;
    const nodeRows = await this.querySql(
      "SELECT COUNT(*) as cnt FROM graph_nodes WHERE org = ? AND workspace = ?",
      [org, workspace],
    );
    const edgeRows = await this.querySql(
      "SELECT COUNT(*) as cnt FROM graph_edges WHERE org = ? AND workspace = ?",
      [org, workspace],
    );
    const cur = await this.getCursor(org, workspace);
    return {
      nodeCount: Number((nodeRows[0] as Record<string, unknown>)["cnt"] ?? 0),
      edgeCount: Number((edgeRows[0] as Record<string, unknown>)["cnt"] ?? 0),
      cursor: cur?.cursor ?? null,
      syncedAt: cur?.syncedAt ?? null,
    };
  }

  async searchNodes(
    org: string,
    workspace: string,
    query: string,
    limit: number,
  ): Promise<GraphNode[]> {
    await this.ready;
    // Escape LIKE wildcards in the user term so a query containing `%` or `_`
    // is matched literally instead of turning into a wildcard (e.g. searching
    // for "50%" must not match everything). Escape the escape char first.
    const escaped = query
      .toLowerCase()
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const q = `%${escaped}%`;
    const rows = await this.querySql(
      `SELECT * FROM graph_nodes
       WHERE org = ? AND workspace = ?
         AND (LOWER(display_name) LIKE ? ESCAPE '\\' OR LOWER(CAST(properties AS VARCHAR)) LIKE ? ESCAPE '\\')
       LIMIT ?`,
      [org, workspace, q, q, limit],
    );
    return rows.map(rowToNode);
  }

  async getNode(
    org: string,
    workspace: string,
    id: string,
  ): Promise<GraphNode | null> {
    await this.ready;
    const rows = await this.querySql(
      "SELECT * FROM graph_nodes WHERE org = ? AND workspace = ? AND id = ?",
      [org, workspace, id],
    );
    if (rows.length === 0) return null;
    return rowToNode(rows[0]!);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    // Wait for init to settle before tearing down so DuckDB callbacks don't
    // fire on a closed connection.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToNode(row: Record<string, unknown>): GraphNode {
  return {
    id: row["id"] as string,
    labels: JSON.parse(row["labels"] as string) as string[],
    displayName: row["display_name"] as string,
    properties: JSON.parse(row["properties"] as string) as Record<
      string,
      unknown
    >,
    sourceId: (row["source_id"] as string | null) ?? undefined,
    isSystem: Boolean(row["is_system"]),
    updatedAt: (row["updated_at"] as string | null) ?? "",
    org: row["org"] as string,
    workspace: row["workspace"] as string,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateGraphStoreOpts {
  /** Path to the DuckDB database file. Use `:memory:` for tests. */
  duckdbPath: string;
}

/**
 * Create a GraphStore for the given DuckDB path.
 *
 * @example
 * const store = createGraphStore({ duckdbPath: "~/.config/oxagen/graph/myws.duckdb" });
 * const store = createGraphStore({ duckdbPath: ":memory:" }); // tests
 */
export function createGraphStore(opts: CreateGraphStoreOpts): GraphStore {
  return new GraphStore({ duckdbPath: opts.duckdbPath });
}
