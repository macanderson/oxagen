/**
 * explore-service.ts — server-side composition of the wired graph capabilities
 * into the explorer wire shapes.
 *
 * The explorer client never calls Neo4j; it POSTs an `ExploreRequest` to
 * `/api/v1/graph/explore`, which (after asserting workspace membership) delegates
 * here. Each op invokes one or more capabilities through the kernel boundary
 * (`invoke`) so IAM + metering + observability all fire. The neighbor fan-out
 * for the initial graph is composed here, in-process, so the client makes a
 * single round-trip instead of N.
 *
 * IMPORTANT: this module is server-only (it imports the handler registry). It
 * must never be pulled into the client bundle — only the route handler imports it.
 */

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { GraphStatsOutput } from "@oxagen/oxagen/contracts/graph.stats";
import type { GraphNodeListOutput } from "@oxagen/oxagen/contracts/graph.node.list";
import type { GraphNodeSearchOutput } from "@oxagen/oxagen/contracts/graph.node.search";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import type { GraphNodeGetOutput } from "@oxagen/oxagen/contracts/graph.node.get";

import type {
  ExploreRequest,
  ExplorerEdge,
  ExplorerExpandPayload,
  ExplorerGraphPayload,
  ExplorerNode,
  ExplorerNodeDetailPayload,
  ExplorerNodesPayload,
  ExplorerSearchPayload,
} from "./types";
import {
  edgesFromNeighbors,
  mergeEdges,
  mergeNodes,
  nodeFromListed,
  nodeFromNeighbor,
  primaryLabel,
  recordToCounts,
  reconcile,
} from "./lib/transform";

// Tuning constants — bounded so the initial render never ships an unbounded
// graph to the browser (WebGL gets slow well before the data does).
const SEED_LIMIT = 60; // nodes seeded into the initial graph
const NEIGHBOR_FANOUT = 24; // seed nodes we walk for intra-graph edges
const NEIGHBOR_LIMIT = 30; // neighbors fetched per seed node
const EXPAND_LIMIT = 60; // neighbors fetched on an explicit expand
const MAX_NODES = 250; // hard ceiling on nodes in the seeded view
const SEARCH_LIMIT = 25;
const DETAIL_NEIGHBORS = 50;

type WithSurface = Parameters<typeof invoke>[3];
const AGENT_SURFACE: WithSurface = { surface: "agent" };

/** Dispatch an explorer request to the matching capability composition. */
export async function dispatchExplore(
  req: ExploreRequest,
  ctx: CapabilityContext,
): Promise<
  | ExplorerGraphPayload
  | ExplorerExpandPayload
  | ExplorerNodesPayload
  | ExplorerSearchPayload
  | ExplorerNodeDetailPayload
> {
  const { orgId, workspaceId } = ctx;
  return runInTenantScope({ orgId, workspaceId }, async () => {
    switch (req.op) {
      case "graph":
        return buildGraph(req, ctx);
      case "expand":
        return expandNode(req.nodeId, ctx);
      case "nodes":
        return listNodes(req, ctx);
      case "search":
        return searchNodes(req, ctx);
      case "node":
        return getNodeDetail(req.nodeId, ctx);
    }
  });
}

/** Initial seeded subgraph: stats + seed nodes + confirmed intra-graph edges. */
async function buildGraph(
  req: Extract<ExploreRequest, { op: "graph" }>,
  ctx: CapabilityContext,
): Promise<ExplorerGraphPayload> {
  const seedLimit = clamp(req.limit ?? SEED_LIMIT, 1, MAX_NODES);

  const [stats, seed] = await Promise.all([
    invoke(
      "get_graph_stats",
      { includeByType: true },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphStatsOutput>,
    invoke(
      "list_nodes",
      {
        ...(req.labels ? { labels: req.labels } : {}),
        limit: seedLimit,
        offset: 0,
      },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphNodeListOutput>,
  ]);

  let nodes: ExplorerNode[] = seed.nodes.map(nodeFromListed);
  let edges: ExplorerEdge[] = [];

  // Walk neighbors of the first N seed nodes to discover the edges that connect
  // them (and a bounded set of adjacent stub nodes). Runs in-process so it is a
  // single client round-trip, not N.
  const fanoutIds = nodes.slice(0, NEIGHBOR_FANOUT).map((n) => n.id);
  const neighborhoods = await Promise.all(
    fanoutIds.map((nodeId) =>
      (
        invoke(
          "get_ontology_neighbors",
          { nodeId, direction: "both", limit: NEIGHBOR_LIMIT },
          ctx,
          AGENT_SURFACE,
        ) as Promise<OntologyNeighborsOutput>
      ).catch(() => null),
    ),
  );

  for (let i = 0; i < neighborhoods.length; i++) {
    const hood = neighborhoods[i];
    const anchorId = fanoutIds[i];
    if (!hood || !anchorId || !hood.found) continue;
    if (nodes.length < MAX_NODES) {
      const room = MAX_NODES - nodes.length;
      nodes = mergeNodes(
        nodes,
        hood.neighbors.slice(0, room).map(nodeFromNeighbor),
      );
    }
    edges = mergeEdges(edges, edgesFromNeighbors(anchorId, hood.neighbors));
  }

  const reconciled = reconcile(nodes, edges);

  return {
    nodes: reconciled.nodes,
    edges: reconciled.edges,
    stats: {
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      inferredEdgeCount: stats.inferredEdgeCount,
      nodesByLabel: recordToCounts(stats.nodesByLabel),
      edgesByType: recordToCounts(stats.edgesByType),
    },
    truncated: stats.nodeCount > reconciled.nodes.length,
  };
}

/** One node's neighborhood — merged into the live graph client-side. */
async function expandNode(
  nodeId: string,
  ctx: CapabilityContext,
): Promise<ExplorerExpandPayload> {
  const hood = (await invoke(
    "get_ontology_neighbors",
    { nodeId, direction: "both", limit: EXPAND_LIMIT },
    ctx,
    AGENT_SURFACE,
  )) as OntologyNeighborsOutput;

  return {
    found: hood.found,
    nodes: hood.neighbors.map(nodeFromNeighbor),
    edges: edgesFromNeighbors(nodeId, hood.neighbors),
  };
}

/** Paginated, filterable, searchable node list for the table view. */
async function listNodes(
  req: Extract<ExploreRequest, { op: "nodes" }>,
  ctx: CapabilityContext,
): Promise<ExplorerNodesPayload> {
  const limit = clamp(req.limit ?? 50, 1, 250);
  const offset = Math.max(0, req.offset ?? 0);
  const result = (await invoke(
    "list_nodes",
    {
      ...(req.labels ? { labels: req.labels } : {}),
      ...(req.query ? { query: req.query } : {}),
      limit,
      offset,
    },
    ctx,
    AGENT_SURFACE,
  )) as GraphNodeListOutput;

  const { nodes } = reconcile(result.nodes.map(nodeFromListed), []);
  return {
    nodes,
    total: result.total,
    hasMore: result.hasMore,
    limit: result.limit,
    offset: result.offset,
  };
}

/** Semantic/text search over node display names + descriptions. */
async function searchNodes(
  req: Extract<ExploreRequest, { op: "search" }>,
  ctx: CapabilityContext,
): Promise<ExplorerSearchPayload> {
  const result = (await invoke(
    "search_nodes",
    {
      query: req.query,
      ...(req.labels ? { labels: req.labels } : {}),
      limit: SEARCH_LIMIT,
    },
    ctx,
    AGENT_SURFACE,
  )) as GraphNodeSearchOutput;

  const nodes: ExplorerNode[] = result.nodes.map((n) => ({
    id: n.nodeId,
    label: n.label,
    displayName: n.displayName,
    description: n.description,
    degree: 0,
    hydrated: false,
  }));
  return { nodes };
}

/** Full node detail (properties) + its directly-connected neighbors. */
async function getNodeDetail(
  nodeId: string,
  ctx: CapabilityContext,
): Promise<ExplorerNodeDetailPayload> {
  const [detail, hood] = await Promise.all([
    invoke(
      "get_node",
      { nodeId },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphNodeGetOutput>,
    (
      invoke(
        "get_ontology_neighbors",
        { nodeId, direction: "both", limit: DETAIL_NEIGHBORS },
        ctx,
        AGENT_SURFACE,
      ) as Promise<OntologyNeighborsOutput>
    ).catch(
      () =>
        ({
          nodeId,
          found: false,
          neighbors: [],
          truncated: false,
        }) as OntologyNeighborsOutput,
    ),
  ]);

  if (!detail.node) return { node: null, neighbors: [] };

  const node: ExplorerNode = {
    id: detail.node.nodeId,
    label: primaryLabel([detail.node.label]),
    displayName: detail.node.displayName,
    description: detail.node.description ?? null,
    properties: detail.node.properties ?? {},
    degree: hood.neighbors.length,
    hydrated: true,
  };

  return {
    node,
    neighbors: hood.neighbors.map((n) => ({
      nodeId: n.nodeId,
      label: n.label,
      displayName: n.displayName,
      edgeType: n.edgeType,
      direction: n.direction,
    })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
