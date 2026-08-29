/**
 * CodeGraphStore — DuckDB-backed persistence for the local code graph.
 *
 * This store persists the code graph (files → symbols → imports) so a cold
 * start loads from disk and only re-parses files whose content changed — the
 * incremental unit is a single file, keyed by a content hash. See
 * ../../../../docs/adr/ADR-016-oxagen-cli-daemon-live-code-graph.md.
 *
 * One DuckDB file holds every repo the user works in, partitioned by `root`
 * (the absolute workspace root). Modeled on @oxagen/engram's GraphStore: a
 * native CJS `require("duckdb")` (shimmed in the CLI entry point and available
 * natively under Node/vitest) and callback→Promise wrappers.
 *
 *   code_nodes  — one row per file/symbol node, (root, id) unique
 *   code_edges  — one row per edge, owned by the file that declares it
 *   code_files  — per-(root, path) content hash + index timestamp (incremental)
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CodeGraph,
  CodeNode,
  CodeEdge,
  CodeNodeKind,
  CodeEdgeType,
} from "./types";

// Minimal structural types for the (native, CJS) `duckdb` module. The CLI pulls
// duckdb in transitively via @oxagen/engram and shims `require` at its entry
// point, but does not depend on duckdb's type declarations directly — so we
// describe only the surface this store uses rather than importing from "duckdb".
interface DuckConnection {
  run(sql: string, ...args: unknown[]): void;
  all(sql: string, ...args: unknown[]): void;
  close(cb: (err: Error | null) => void): void;
}
interface DuckDatabase {
  connect(): DuckConnection;
  close(cb: (err: Error | null) => void): void;
}
interface DuckModule {
  Database: new (path: string) => DuckDatabase;
}

/** Default on-disk location — a dedicated DuckDB file, separate from the
 *  engram context store so the two never contend for the same file lock. */
export function defaultCodeGraphDbPath(): string {
  return join(homedir(), ".config", "oxagen", "code-graph.duckdb");
}

/** Deterministic edge id so re-indexing a file replaces, never duplicates. */
export function computeEdgeId(
  source: string,
  target: string,
  type: string,
): string {
  return createHash("sha256")
    .update(`${source}:${target}:${type}`)
    .digest("hex")
    .slice(0, 32);
}

/** blake3-free content hash of a file's text (sha256 hex). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface CodeGraphStoreStats {
  files: number;
  symbols: number;
  edges: number;
}

export interface CodeGraphStoreOpts {
  /** Path to the DuckDB database file. Use `:memory:` for tests. */
  duckdbPath: string;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const CREATE_NODES_SQL = `
  CREATE TABLE IF NOT EXISTS code_nodes (
    root        VARCHAR NOT NULL,
    id          VARCHAR NOT NULL,
    kind        VARCHAR NOT NULL,
    name        VARCHAR NOT NULL,
    path        VARCHAR NOT NULL,
    range_start INTEGER NOT NULL,
    range_end   INTEGER NOT NULL,
    language    VARCHAR NOT NULL,
    signature   VARCHAR,
    docstring   VARCHAR,
    domain      VARCHAR,
    embedding   VARCHAR,
    embedding_provider VARCHAR,
    PRIMARY KEY (root, id)
  )
`;

// Migration: add domain column to existing DBs that pre-date this schema change.
// DuckDB supports ADD COLUMN IF NOT EXISTS, so this is safe on fresh DBs too.
const MIGRATE_ADD_DOMAIN_SQL =
  "ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS domain VARCHAR";

// Migration: add the Group 3 semantic-index columns. `embedding` holds the
// JSON-encoded float vector (a VARCHAR, not a native array, so the raw duckdb
// callback driver needs no array binding), `embedding_provider` the id of the
// provider that produced it so a provider swap re-embeds instead of comparing
// incompatible vectors.
const MIGRATE_ADD_EMBEDDING_SQL =
  "ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS embedding VARCHAR";
const MIGRATE_ADD_EMBEDDING_PROVIDER_SQL =
  "ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS embedding_provider VARCHAR";

const CREATE_EDGES_SQL = `
  CREATE TABLE IF NOT EXISTS code_edges (
    root      VARCHAR NOT NULL,
    id        VARCHAR NOT NULL,
    file_path VARCHAR NOT NULL,
    source    VARCHAR NOT NULL,
    target    VARCHAR NOT NULL,
    type      VARCHAR NOT NULL,
    domain    VARCHAR,
    PRIMARY KEY (root, id)
  )
`;

// Migration: add domain column to existing DBs that pre-date this schema change.
const MIGRATE_ADD_EDGE_DOMAIN_SQL =
  "ALTER TABLE code_edges ADD COLUMN IF NOT EXISTS domain VARCHAR";

const CREATE_FILES_SQL = `
  CREATE TABLE IF NOT EXISTS code_files (
    root         VARCHAR NOT NULL,
    path         VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    indexed_at   BIGINT  NOT NULL,
    PRIMARY KEY (root, path)
  )
`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** A single file's extracted subgraph, the unit of incremental replacement. */
export interface FileGraph {
  contentHash: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export class CodeGraphStore {
  private db: DuckDatabase;
  private conn: DuckConnection;
  private ready: Promise<void>;

  constructor(opts: CodeGraphStoreOpts) {
    // duckdb is a native CJS module; require() is shimmed in the CLI entry point
    // and available natively under Node/vitest.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- duckdb uses CJS
    const duckdb = require("duckdb") as DuckModule;
    this.db = new duckdb.Database(opts.duckdbPath);
    this.conn = this.db.connect();
    this.ready = this.initialize();
    // Swallow early rejection so a locked file never crashes the host; callers
    // observe it through their own awaits.
    void this.ready.catch(() => {});
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.run(CREATE_NODES_SQL, (e1: Error | null) => {
        if (e1) return reject(e1);
        this.conn.run(CREATE_EDGES_SQL, (e2: Error | null) => {
          if (e2) return reject(e2);
          this.conn.run(CREATE_FILES_SQL, (e3: Error | null) => {
            if (e3) return reject(e3);
            // Migrate existing DBs: add domain column if it does not exist.
            this.conn.run(MIGRATE_ADD_DOMAIN_SQL, (e4: Error | null) => {
              if (e4) return reject(e4);
              // Group 3: add the semantic-index columns (embedding + provider).
              this.conn.run(MIGRATE_ADD_EMBEDDING_SQL, (e5: Error | null) => {
                if (e5) return reject(e5);
                this.conn.run(
                  MIGRATE_ADD_EMBEDDING_PROVIDER_SQL,
                  (e6: Error | null) => {
                    if (e6) return reject(e6);
                    // Edge domain tagging: mirrors the node-level migration above.
                    this.conn.run(
                      MIGRATE_ADD_EDGE_DOMAIN_SQL,
                      (e7: Error | null) => {
                        if (e7) return reject(e7);
                        resolve();
                      },
                    );
                  },
                );
              });
            });
          });
        });
      });
    });
  }

  /** Resolve once the schema is ready (or reject if the DB could not open). */
  whenReady(): Promise<void> {
    return this.ready;
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

  // -------------------------------------------------------------------------
  // Incremental write
  // -------------------------------------------------------------------------

  /** Stored content hash for a file, or null if never indexed. */
  async fileHash(root: string, relPath: string): Promise<string | null> {
    await this.ready;
    const rows = await this.querySql(
      "SELECT content_hash FROM code_files WHERE root = ? AND path = ?",
      [root, relPath],
    );
    return rows.length ? (rows[0]!["content_hash"] as string) : null;
  }

  /** All file paths currently indexed for a root (used to detect deletions). */
  async indexedFiles(root: string): Promise<string[]> {
    await this.ready;
    const rows = await this.querySql(
      "SELECT path FROM code_files WHERE root = ?",
      [root],
    );
    return rows.map((r) => r["path"] as string);
  }

  /**
   * Replace one file's nodes/edges atomically. Deletes the file's prior nodes
   * (matched by `path`) and the edges it declared (matched by `file_path`),
   * inserts the new subgraph, and records the content hash. Idempotent: calling
   * twice with the same hash yields the same rows.
   */
  async replaceFile(
    root: string,
    relPath: string,
    fileGraph: FileGraph,
  ): Promise<void> {
    await this.ready;
    await this.runSql("BEGIN TRANSACTION");
    try {
      await this.runSql("DELETE FROM code_nodes WHERE root = ? AND path = ?", [
        root,
        relPath,
      ]);
      await this.runSql(
        "DELETE FROM code_edges WHERE root = ? AND file_path = ?",
        [root, relPath],
      );
      for (const n of fileGraph.nodes) {
        await this.runSql(
          `INSERT INTO code_nodes
             (root, id, kind, name, path, range_start, range_end, language, signature, docstring, domain, embedding, embedding_provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (root, id) DO UPDATE SET
             kind = excluded.kind, name = excluded.name, path = excluded.path,
             range_start = excluded.range_start, range_end = excluded.range_end,
             language = excluded.language, signature = excluded.signature,
             docstring = excluded.docstring, domain = excluded.domain,
             embedding = excluded.embedding, embedding_provider = excluded.embedding_provider`,
          [
            root,
            n.id,
            n.kind,
            n.name,
            n.path,
            n.range.start,
            n.range.end,
            n.language,
            n.signature ?? null,
            n.docstring ?? null,
            n.domain ?? null,
            n.embedding ? JSON.stringify(n.embedding) : null,
            n.embeddingProvider ?? null,
          ],
        );
      }
      for (const e of fileGraph.edges) {
        const id = computeEdgeId(e.source, e.target, e.type);
        await this.runSql(
          `INSERT INTO code_edges (root, id, file_path, source, target, type, domain)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (root, id) DO UPDATE SET
             file_path = excluded.file_path, source = excluded.source,
             target = excluded.target, type = excluded.type, domain = excluded.domain`,
          [root, id, relPath, e.source, e.target, e.type, e.domain ?? null],
        );
      }
      await this.runSql(
        `INSERT INTO code_files (root, path, content_hash, indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (root, path) DO UPDATE SET
           content_hash = excluded.content_hash, indexed_at = excluded.indexed_at`,
        [root, relPath, fileGraph.contentHash, Date.now()],
      );
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  /** Drop a file that no longer exists on disk, with its nodes and edges. */
  async removeFile(root: string, relPath: string): Promise<void> {
    await this.ready;
    await this.runSql("BEGIN TRANSACTION");
    try {
      await this.runSql("DELETE FROM code_nodes WHERE root = ? AND path = ?", [
        root,
        relPath,
      ]);
      await this.runSql(
        "DELETE FROM code_edges WHERE root = ? AND file_path = ?",
        [root, relPath],
      );
      await this.runSql("DELETE FROM code_files WHERE root = ? AND path = ?", [
        root,
        relPath,
      ]);
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Domain updates
  // -------------------------------------------------------------------------

  /**
   * Bulk-stamp the `domain` property on all code_nodes (file + symbol nodes)
   * whose relative path matches a key in `domainMap`.
   *
   * Called by local graph initialization after `inferDomains()` so DuckDB
   * queries can filter and summarize application domains.
   *
   * Idempotent: re-running with the same map is a no-op.
   */
  async updateNodeDomains(
    root: string,
    domainMap: Map<string, string>,
  ): Promise<void> {
    await this.ready;
    if (domainMap.size === 0) return;

    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const [relPath, domain] of domainMap) {
        await this.runSql(
          "UPDATE code_nodes SET domain = ? WHERE root = ? AND path = ?",
          [domain, root, relPath],
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  /**
   * Bulk-stamp the `domain` property on every code_edge declared by a file
   * (`file_path`) whose relative path matches a key in `domainMap` — the same
   * "declaring file owns it" rule `code_edges.file_path` already uses (see the
   * module doc comment). An edge whose declaring file has no confident domain
   * is left untouched (null), matching `updateNodeDomains` — never fabricated.
   *
   * Called alongside `updateNodeDomains` so a domain slices the whole subgraph
   * a file contributes, not just its nodes.
   *
   * Idempotent: re-running with the same map is a no-op.
   */
  async updateEdgeDomains(
    root: string,
    domainMap: Map<string, string>,
  ): Promise<void> {
    await this.ready;
    if (domainMap.size === 0) return;

    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const [relPath, domain] of domainMap) {
        await this.runSql(
          "UPDATE code_edges SET domain = ? WHERE root = ? AND file_path = ?",
          [domain, root, relPath],
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Embedding updates (Group 3 semantic index)
  // -------------------------------------------------------------------------

  /**
   * Bulk-persist semantic embeddings on individual nodes, keyed by node id.
   * Called by the semantic index after it embeds file nodes lazily at query
   * time, so a cold start reuses the vectors instead of re-embedding.
   *
   * Idempotent: re-running with the same vectors is a no-op. Rows whose id is
   * absent for this root are simply not updated.
   */
  async updateNodeEmbeddings(
    root: string,
    embeddings: Map<string, { vector: number[]; provider: string }>,
  ): Promise<void> {
    await this.ready;
    if (embeddings.size === 0) return;

    await this.runSql("BEGIN TRANSACTION");
    try {
      for (const [id, { vector, provider }] of embeddings) {
        await this.runSql(
          "UPDATE code_nodes SET embedding = ?, embedding_provider = ? WHERE root = ? AND id = ?",
          [JSON.stringify(vector), provider, root, id],
        );
      }
      await this.runSql("COMMIT");
    } catch (err) {
      await this.runSql("ROLLBACK");
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Reconstruct the full in-memory CodeGraph for a root. */
  async loadGraph(root: string): Promise<CodeGraph> {
    await this.ready;
    const nodeRows = await this.querySql(
      `SELECT id, kind, name, path, range_start, range_end, language, signature, docstring, domain, embedding, embedding_provider
       FROM code_nodes WHERE root = ?`,
      [root],
    );
    const edgeRows = await this.querySql(
      "SELECT source, target, type, domain FROM code_edges WHERE root = ?",
      [root],
    );
    const nodes = new Map<string, CodeNode>();
    for (const r of nodeRows) nodes.set(r["id"] as string, rowToNode(r));
    const edges: CodeEdge[] = edgeRows.map((r) => ({
      source: r["source"] as string,
      target: r["target"] as string,
      type: r["type"] as CodeEdgeType,
      domain: (r["domain"] as string | null) ?? undefined,
    }));
    return { nodes, edges };
  }

  async stats(root: string): Promise<CodeGraphStoreStats> {
    await this.ready;
    const fileRows = await this.querySql(
      "SELECT COUNT(*) AS cnt FROM code_nodes WHERE root = ? AND kind = 'file'",
      [root],
    );
    const symRows = await this.querySql(
      "SELECT COUNT(*) AS cnt FROM code_nodes WHERE root = ? AND kind <> 'file'",
      [root],
    );
    const edgeRows = await this.querySql(
      "SELECT COUNT(*) AS cnt FROM code_edges WHERE root = ?",
      [root],
    );
    return {
      files: Number((fileRows[0] as Record<string, unknown>)["cnt"] ?? 0),
      symbols: Number((symRows[0] as Record<string, unknown>)["cnt"] ?? 0),
      edges: Number((edgeRows[0] as Record<string, unknown>)["cnt"] ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.ready.catch(() => {});
    return new Promise((resolve, reject) => {
      this.conn.close((err: Error | null) => {
        if (err) return reject(err);
        this.db.close((err2: Error | null) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }
}

function rowToNode(row: Record<string, unknown>): CodeNode {
  return {
    id: row["id"] as string,
    kind: row["kind"] as CodeNodeKind,
    name: row["name"] as string,
    path: row["path"] as string,
    range: { start: Number(row["range_start"]), end: Number(row["range_end"]) },
    language: row["language"] as string,
    signature: (row["signature"] as string | null) ?? undefined,
    docstring: (row["docstring"] as string | null) ?? undefined,
    domain: (row["domain"] as string | null) ?? undefined,
    embedding: parseEmbedding(row["embedding"]),
    embeddingProvider:
      (row["embedding_provider"] as string | null) ?? undefined,
  };
}

/** Parse a stored embedding cell (JSON-encoded float array) back to numbers. */
function parseEmbedding(cell: unknown): number[] | undefined {
  if (typeof cell !== "string" || cell.length === 0) return undefined;
  try {
    const parsed = JSON.parse(cell) as unknown;
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
      return parsed as number[];
    }
  } catch {
    /* corrupt cell — treat as no embedding rather than failing the whole load */
  }
  return undefined;
}

/** Create a CodeGraphStore. `:memory:` for tests, a file path otherwise. */
export function createCodeGraphStore(opts: CodeGraphStoreOpts): CodeGraphStore {
  return new CodeGraphStore(opts);
}
