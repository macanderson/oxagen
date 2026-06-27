/**
 * `oxagen graph pull` — download an incremental snapshot of the workspace
 * knowledge graph into a local DuckDB replica.
 *
 * The replica lives at `~/.config/oxagen/graph/<workspaceSlug>.duckdb`.  A
 * sync cursor (high-watermark string + counts) is persisted after every pull so
 * subsequent runs only fetch what changed.  Pass `--full` to ignore the cursor
 * and re-pull everything.
 *
 * Pagination: the pull loop calls `graph/export` with `limit=500` + an
 * incrementing `offset` until `hasMore` is false, then persists the cursor
 * returned by the last page.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiPost } from "../lib/api.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";
import { createGraphStore } from "@oxagen/engram";
import type { GraphNode, GraphEdge } from "@oxagen/engram";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphPullOptions {
  full?: boolean;
  labels?: string;
  noSystem?: boolean;
  json?: boolean;
  /**
   * @internal test seam: override the DuckDB path.
   * Pass `":memory:"` in tests to avoid touching the filesystem.
   */
  _duckdbPath?: string;
}

/** Shape of a single page returned by the `graph/export` capability. */
interface GraphExportPage {
  nodes: RemoteNode[];
  edges: RemoteEdge[];
  hasMore: boolean;
  /** High-watermark cursor for the next incremental pull. */
  cursor?: string;
}

interface RemoteNode {
  id: string;
  labels: string[];
  displayName: string;
  properties: Record<string, unknown>;
  sourceId?: string;
  isSystem?: boolean;
  updatedAt?: string;
}

interface RemoteEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  inferred?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;

/** Canonical DuckDB path for a given workspace slug. */
export function graphStorePath(workspaceSlug: string): string {
  return join(homedir(), ".config", "oxagen", "graph", `${workspaceSlug}.duckdb`);
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphPull(opts: GraphPullOptions): Promise<void> {
  const org = getOrgId();
  const workspace = getWorkspaceId();

  if (!org || !workspace) {
    process.stderr.write(
      "Missing org or workspace. Run `oxagen config` or set " +
        "OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.\n",
    );
    process.exitCode = 1;
    return;
  }

  // Resolve DuckDB path — test seam allows ":memory:" to skip filesystem ops.
  const duckdbPath = opts._duckdbPath ?? graphStorePath(workspace);
  if (duckdbPath !== ":memory:") {
    mkdirSync(dirname(duckdbPath), { recursive: true });
  }

  const store = createGraphStore({ duckdbPath });

  try {
    // Determine the starting cursor (skip if --full).
    let updatedAfter: string | undefined;
    if (!opts.full) {
      const existing = await store.getCursor(org, workspace);
      updatedAfter = existing?.cursor;
    }

    const labelArray = splitCsv(opts.labels);
    const isSystem: boolean | undefined = opts.noSystem ? false : undefined;

    // Pull loop: paginate until hasMore=false.
    let offset = 0;
    let totalNodes = 0;
    let totalEdges = 0;
    let newCursor: string | undefined;

     
    while (true) {
      const page = await apiPost<GraphExportPage>("graph/export", {
        updatedAfter,
        labels: labelArray,
        isSystem,
        limit: PAGE_SIZE,
        offset,
      });

      // Enrich remote nodes/edges with local org+workspace keys.
      const nodes: GraphNode[] = page.nodes.map((n) => ({
        id: n.id,
        labels: n.labels,
        displayName: n.displayName,
        properties: n.properties,
        sourceId: n.sourceId,
        isSystem: n.isSystem ?? false,
        updatedAt: n.updatedAt ?? new Date().toISOString(),
        org,
        workspace,
      }));

      const edges: GraphEdge[] = page.edges.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        properties: e.properties,
        inferred: e.inferred ?? false,
        org,
        workspace,
      }));

      await store.upsertNodes(nodes);
      await store.upsertEdges(edges);

      totalNodes += nodes.length;
      totalEdges += edges.length;
      if (page.cursor) newCursor = page.cursor;

      process.stderr.write(
        `  Pulled ${totalNodes} nodes, ${totalEdges} edges (offset=${offset})...\r`,
      );

      if (!page.hasMore) break;
      offset += PAGE_SIZE;
    }

    // Clear the progress line.
    process.stderr.write("\n");

    // Persist the cursor after a successful pull.
    const finalStats = await store.stats(org, workspace);
    const cursorToStore = newCursor ?? new Date().toISOString();
    await store.setCursor(
      org,
      workspace,
      cursorToStore,
      finalStats.nodeCount,
      finalStats.edgeCount,
    );

    // Report summary.
    const summary = {
      pulled: { nodes: totalNodes, edges: totalEdges },
      total: { nodes: finalStats.nodeCount, edges: finalStats.edgeCount },
      cursor: cursorToStore,
      path: duckdbPath,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Pulled ${totalNodes} node(s) and ${totalEdges} edge(s) this run.\n` +
          `Total in local store: ${finalStats.nodeCount} nodes, ${finalStats.edgeCount} edges.\n` +
          `Cursor: ${cursorToStore}\n` +
          `Path: ${duckdbPath}\n`,
      );
    }
  } finally {
    await store.close();
  }
}
