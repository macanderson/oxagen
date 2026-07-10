/**
 * api-client.ts — thin typed client for `/api/v1/graph/explore`.
 *
 * One POST endpoint, one op per call. Keeps the React tree free of fetch
 * boilerplate and centralises error handling so every caller throws a real
 * Error on a non-2xx response.
 */

import type {
  ExplorerDeleteEdgePayload,
  ExplorerDeleteNodePayload,
  ExplorerExpandPayload,
  ExplorerGraphPayload,
  ExplorerNodeDetailPayload,
  ExplorerNodesPayload,
  ExplorerSearchPayload,
  ExplorerSimilaritySearchPayload,
  ExplorerUpsertEdgePayload,
  ExplorerUpsertNodePayload,
  ExplorerVocabPayload,
} from "./types";

export interface TenantSlugs {
  orgSlug: string;
  workspaceSlug: string;
}

async function post<T>(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch("/api/v1/graph/explore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      // keep the status-based default
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Read ops
// ---------------------------------------------------------------------------

export function fetchGraph(
  t: TenantSlugs,
  opts: { labels?: string[]; limit?: number; includeSystem?: boolean } = {},
  signal?: AbortSignal,
): Promise<ExplorerGraphPayload> {
  return post<ExplorerGraphPayload>({ ...t, op: "graph", ...opts }, signal);
}

export function expandNode(
  t: TenantSlugs,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ExplorerExpandPayload> {
  return post<ExplorerExpandPayload>({ ...t, op: "expand", nodeId }, signal);
}

export function fetchNodes(
  t: TenantSlugs,
  opts: {
    labels?: string[];
    query?: string;
    limit?: number;
    offset?: number;
    includeSystem?: boolean;
  } = {},
  signal?: AbortSignal,
): Promise<ExplorerNodesPayload> {
  return post<ExplorerNodesPayload>({ ...t, op: "nodes", ...opts }, signal);
}

export function searchNodes(
  t: TenantSlugs,
  query: string,
  labels?: string[],
  signal?: AbortSignal,
): Promise<ExplorerSearchPayload> {
  return post<ExplorerSearchPayload>(
    { ...t, op: "search", query, ...(labels ? { labels } : {}) },
    signal,
  );
}

export function fetchNodeDetail(
  t: TenantSlugs,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ExplorerNodeDetailPayload> {
  return post<ExplorerNodeDetailPayload>({ ...t, op: "node", nodeId }, signal);
}

// ---------------------------------------------------------------------------
// Vocabulary — distinct labels and relationship types in the workspace graph.
// ---------------------------------------------------------------------------

export function fetchVocab(
  t: TenantSlugs,
  signal?: AbortSignal,
): Promise<ExplorerVocabPayload> {
  return post<ExplorerVocabPayload>({ ...t, op: "vocab" }, signal);
}

// ---------------------------------------------------------------------------
// Similarity search — embedding/fuzzy search for node endpoint pickers.
// ---------------------------------------------------------------------------

export function similaritySearch(
  t: TenantSlugs,
  query: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<ExplorerSimilaritySearchPayload> {
  return post<ExplorerSimilaritySearchPayload>(
    {
      ...t,
      op: "similaritySearch",
      query,
      ...(limit != null ? { limit } : {}),
    },
    signal,
  );
}

// ---------------------------------------------------------------------------
// Mutation ops — CRUD for nodes and edges.
// ---------------------------------------------------------------------------

export function upsertNode(
  t: TenantSlugs,
  data: {
    label: string;
    displayName: string;
    description?: string;
    properties?: Record<string, unknown>;
    externalId?: string;
  },
  signal?: AbortSignal,
): Promise<ExplorerUpsertNodePayload> {
  return post<ExplorerUpsertNodePayload>(
    { ...t, op: "upsertNode", ...data },
    signal,
  );
}

export function deleteNode(
  t: TenantSlugs,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ExplorerDeleteNodePayload> {
  return post<ExplorerDeleteNodePayload>(
    { ...t, op: "deleteNode", nodeId },
    signal,
  );
}

export function upsertEdge(
  t: TenantSlugs,
  data: {
    fromNodeId: string;
    toNodeId: string;
    relationshipType: string;
    properties?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<ExplorerUpsertEdgePayload> {
  return post<ExplorerUpsertEdgePayload>(
    { ...t, op: "upsertEdge", ...data },
    signal,
  );
}

export function deleteEdge(
  t: TenantSlugs,
  data: { fromNodeId: string; toNodeId: string; edgeType: string },
  signal?: AbortSignal,
): Promise<ExplorerDeleteEdgePayload> {
  return post<ExplorerDeleteEdgePayload>(
    { ...t, op: "deleteEdge", ...data },
    signal,
  );
}
