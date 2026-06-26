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
import type { SemanticEdgeListOutput } from "@oxagen/oxagen/contracts/semantic.edge.list";
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
  ExplorerUpsertNodePayload,
  ExplorerDeleteNodePayload,
  ExplorerUpsertEdgePayload,
  ExplorerDeleteEdgePayload,
  ExplorerVocabPayload,
  ExplorerSimilaritySearchPayload,
} from "./types";
import type { GraphNodeUpsertOutput } from "@oxagen/oxagen/contracts/graph.node.upsert";
import type { GraphNodeDeleteOutput } from "@oxagen/oxagen/contracts/graph.node.delete";
import type { GraphEdgeUpsertOutput } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import type { GraphEdgeDeleteOutput } from "@oxagen/oxagen/contracts/graph.edge.delete";
import {
  edgeFromSemantic,
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
const SEMANTIC_LIMIT = 120; // inferred edges considered for the seed
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
  | ExplorerUpsertNodePayload
  | ExplorerDeleteNodePayload
  | ExplorerUpsertEdgePayload
  | ExplorerDeleteEdgePayload
  | ExplorerVocabPayload
  | ExplorerSimilaritySearchPayload
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
      case "upsertNode":
        return upsertNode(req, ctx);
      case "deleteNode":
        return deleteNode(req.nodeId, ctx);
      case "upsertEdge":
        return upsertEdge(req, ctx);
      case "deleteEdge":
        return deleteEdge(req, ctx);
      case "vocab":
        return getVocab(ctx);
      case "similaritySearch":
        return similaritySearch(req, ctx);
    }
  });
}

/** Initial seeded subgraph: stats + seed nodes + intra-graph + inferred edges. */
async function buildGraph(
  req: Extract<ExploreRequest, { op: "graph" }>,
  ctx: CapabilityContext,
): Promise<ExplorerGraphPayload> {
  const seedLimit = clamp(req.limit ?? SEED_LIMIT, 1, MAX_NODES);

  const [stats, seed, semantic] = await Promise.all([
    invoke(
      "graph.stats",
      { includeByType: true },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphStatsOutput>,
    invoke(
      "graph.node.list",
      {
        ...(req.labels ? { labels: req.labels } : {}),
        limit: seedLimit,
        offset: 0,
      },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphNodeListOutput>,
    (
      invoke(
        "semantic.edge.list",
        { limit: SEMANTIC_LIMIT, offset: 0 },
        ctx,
        AGENT_SURFACE,
      ) as Promise<SemanticEdgeListOutput>
    ).catch(
      () =>
        ({
          edges: [],
          total: 0,
          limit: SEMANTIC_LIMIT,
          offset: 0,
        }) as SemanticEdgeListOutput,
    ),
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
          "ontology.neighbors",
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

  // Overlay inferred edges whose endpoints are already in view.
  edges = mergeEdges(edges, semantic.edges.map(edgeFromSemantic));

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
    "ontology.neighbors",
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
    "graph.node.list",
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
    "graph.node.search",
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
      "graph.node.get",
      { nodeId },
      ctx,
      AGENT_SURFACE,
    ) as Promise<GraphNodeGetOutput>,
    (
      invoke(
        "ontology.neighbors",
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

// ---------------------------------------------------------------------------
// Mutation ops — CRUD through the kernel so IAM/metering/audit all fire.
// ---------------------------------------------------------------------------

/** Create or update a node. */
async function upsertNode(
  req: Extract<ExploreRequest, { op: "upsertNode" }>,
  ctx: CapabilityContext,
): Promise<ExplorerUpsertNodePayload> {
  const result = (await invoke(
    "graph.node.upsert",
    {
      label: req.label,
      displayName: req.displayName,
      ...(req.description ? { description: req.description } : {}),
      ...(req.properties ? { properties: req.properties } : {}),
      ...(req.externalId ? { externalId: req.externalId } : {}),
    },
    ctx,
    AGENT_SURFACE,
  )) as GraphNodeUpsertOutput;

  return { nodeId: result.nodeId, created: result.created };
}

/** Delete a node and all its relationships. */
async function deleteNode(
  nodeId: string,
  ctx: CapabilityContext,
): Promise<ExplorerDeleteNodePayload> {
  const result = (await invoke(
    "graph.node.delete",
    { nodeId },
    ctx,
    AGENT_SURFACE,
  )) as GraphNodeDeleteOutput;

  return { deleted: result.deleted };
}

/** Create or update a relationship between two nodes. */
async function upsertEdge(
  req: Extract<ExploreRequest, { op: "upsertEdge" }>,
  ctx: CapabilityContext,
): Promise<ExplorerUpsertEdgePayload> {
  const result = (await invoke(
    "graph.edge.upsert",
    {
      fromNodeId: req.fromNodeId,
      toNodeId: req.toNodeId,
      relationshipType: req.relationshipType,
      ...(req.properties ? { properties: req.properties } : {}),
    },
    ctx,
    AGENT_SURFACE,
  )) as GraphEdgeUpsertOutput;

  return { edgeId: result.edgeId, created: result.created };
}

/** Delete a specific relationship between two nodes. */
async function deleteEdge(
  req: Extract<ExploreRequest, { op: "deleteEdge" }>,
  ctx: CapabilityContext,
): Promise<ExplorerDeleteEdgePayload> {
  const result = (await invoke(
    "graph.edge.delete",
    {
      fromNodeId: req.fromNodeId,
      toNodeId: req.toNodeId,
      edgeType: req.edgeType,
    },
    ctx,
    AGENT_SURFACE,
  )) as GraphEdgeDeleteOutput;

  return { deleted: result.deleted };
}

/**
 * Vocabulary: distinct node labels and relationship types already in the
 * workspace graph. Drives the select lists in create/edit dialogs so the user
 * can pick from what already exists or type a new one.
 */
async function getVocab(ctx: CapabilityContext): Promise<ExplorerVocabPayload> {
  const stats = (await invoke(
    "graph.stats",
    { includeByType: true },
    ctx,
    AGENT_SURFACE,
  )) as GraphStatsOutput;

  const labels = stats.nodesByLabel
    ? Object.keys(stats.nodesByLabel).sort()
    : [];
  const relationshipTypes = stats.edgesByType
    ? Object.keys(stats.edgesByType).sort()
    : [];

  return { labels, relationshipTypes };
}

const SIMILARITY_LIMIT = 15;

/**
 * Similarity search: uses the existing graph.node.search capability (fuzzy text
 * match on displayName/description). Returns lightweight node stubs for use in
 * edge endpoint pickers.
 */
async function similaritySearch(
  req: Extract<ExploreRequest, { op: "similaritySearch" }>,
  ctx: CapabilityContext,
): Promise<ExplorerSimilaritySearchPayload> {
  const limit = clamp(req.limit ?? SIMILARITY_LIMIT, 1, 50);
  const result = (await invoke(
    "graph.node.search",
    { query: req.query, limit },
    ctx,
    AGENT_SURFACE,
  )) as GraphNodeSearchOutput;

  return {
    nodes: result.nodes.map((n) => ({
      nodeId: n.nodeId,
      label: n.label,
      displayName: n.displayName,
      score: n.score,
    })),
  };
}
