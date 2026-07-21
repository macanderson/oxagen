/**
 * use-explorer-data.ts — live-graph state for the explorer.
 *
 * Owns the in-view nodes/edges (as one atomic object so merges stay
 * consistent), the whole-graph stats, and load status. The initial seed is
 * fetched once on mount; `expand` walks a node's neighborhood and merges it in
 * (deduped, degree-recomputed); `addSubgraph` folds search hits into the view.
 * All merges go through the pure `transform` helpers so the dedupe/degree maths
 * stays testable.
 */

"use client";

import * as React from "react";
import type { ExplorerEdge, ExplorerNode, ExplorerStats } from "./types";
import { fetchGraph, expandNode, type TenantSlugs } from "./api-client";
import { mergeEdges, mergeNodes, reconcile } from "./lib/transform";

export type LoadStatus = "loading" | "ready" | "error";

interface Graph {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
}

export interface ExplorerGraphState {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  stats: ExplorerStats | null;
  status: LoadStatus;
  error: string | null;
  truncated: boolean;
  /** Node id currently being expanded, for per-node spinner affordances. */
  expandingId: string | null;
  reload: () => void;
  expand: (nodeId: string) => Promise<void>;
  /** Fold an externally-fetched subgraph (e.g. search hits) into the view. */
  addSubgraph: (nodes: ExplorerNode[], edges: ExplorerEdge[]) => void;
}

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

export function useExplorerData(tenant: TenantSlugs): ExplorerGraphState {
  const [graph, setGraph] = React.useState<Graph>(EMPTY_GRAPH);
  const [stats, setStats] = React.useState<ExplorerStats | null>(null);
  const [status, setStatus] = React.useState<LoadStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [expandingId, setExpandingId] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setStatus("loading");
    setError(null);
    fetchGraph(tenant, {}, controller.signal)
      .then((payload) => {
        if (!active) return;
        setGraph({ nodes: payload.nodes, edges: payload.edges });
        setStats(payload.stats);
        setTruncated(payload.truncated);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load graph");
        setStatus("error");
      });
    return () => {
      active = false;
      controller.abort();
    };
    // tenant slugs are stable for the page lifetime; reloadKey forces a
    // refetch.
  }, [tenant, reloadKey]);

  const addSubgraph = React.useCallback(
    (incomingNodes: ExplorerNode[], incomingEdges: ExplorerEdge[]) => {
      setGraph((prev) =>
        reconcile(
          mergeNodes(prev.nodes, incomingNodes),
          mergeEdges(prev.edges, incomingEdges),
        ),
      );
    },
    [],
  );

  const expand = React.useCallback(
    async (nodeId: string) => {
      setExpandingId(nodeId);
      try {
        const payload = await expandNode(tenant, nodeId);
        if (payload.found) addSubgraph(payload.nodes, payload.edges);
      } catch {
        // Non-fatal: a failed expand leaves the current view intact.
      } finally {
        setExpandingId(null);
      }
    },
    [tenant, addSubgraph],
  );

  return {
    nodes: graph.nodes,
    edges: graph.edges,
    stats,
    status,
    error,
    truncated,
    expandingId,
    reload,
    expand,
    addSubgraph,
  };
}
