"use server";

/**
 * actions.ts — server actions for Knowledge → Graph's Browse / Search / Query
 * panels (web-app-2.0 Phase 2). Every action follows the exact pattern used by
 * knowledge/memory/actions.ts:
 *   1. getSessionOrRedirect() → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR + org/workspace resolution
 *   3. assertOrgMember() → org membership guard
 *   4. assertWorkspaceMember() (inline) → workspace role guard, since
 *      apps/app does NOT bootstrap IAM and invoke() skips role checks
 *   5. invoke() with the capability's exact `name:` (verified against
 *      packages/oxagen/src/contracts/*.ts — see the comment above each action)
 *   6. return an `{ ok: true, ... } | { ok: false, error }` result — no thrown
 *      errors cross the server-action boundary
 *
 * Surface note: every capability here is invoked with `{ surface: "agent" }`
 * EXCEPT `export_graph`, whose contract (graph.export.ts) declares
 * `surfaces: ["api", "mcp"]` — no "agent" entry — so `{ surface: "agent" }`
 * would throw `surface_denied`. `exportGraphAction` uses `{ surface: "api" }`
 * instead (same pattern as reconcile-actions.ts / privacy-actions.ts).
 */

import { and, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: binds every handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { withTenantDb, schema } from "@oxagen/database";
import type { GraphNodeListOutput } from "@oxagen/oxagen/contracts/graph.node.list";
import type { GraphNodeSearchOutput } from "@oxagen/oxagen/contracts/graph.node.search";
import type { GraphSearchOutput } from "@oxagen/oxagen/contracts/graph.search";
import type { GraphStatsOutput } from "@oxagen/oxagen/contracts/graph.stats";
import type { GraphCypherOutput } from "@oxagen/oxagen/contracts/graph.cypher";
import type { GraphExportOutput } from "@oxagen/oxagen/contracts/graph.export";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import type { OntologyQueryOutput } from "@oxagen/oxagen/contracts/ontology.query";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type GraphStatsSummary = Omit<GraphStatsOutput, "render">;

export type ListNodesResult =
  | {
      ok: true;
      nodes: GraphNodeListOutput["nodes"];
      total: number;
      hasMore: boolean;
      limit: number;
      offset: number;
    }
  | { ok: false; error: string };

export type SearchNodesResult =
  | { ok: true; nodes: GraphNodeSearchOutput["nodes"] }
  | { ok: false; error: string };

export type SemanticSearchResult =
  | { ok: true; results: GraphSearchOutput["results"] }
  | { ok: false; error: string };

export type GraphStatsResult =
  | { ok: true; stats: GraphStatsSummary }
  | { ok: false; error: string };

export type RunCypherResult =
  | { ok: true; rows: GraphCypherOutput["rows"]; columns: string[]; rowCount: number }
  | { ok: false; error: string };

export type ExportGraphResult =
  | { ok: true; nodes: GraphExportOutput["nodes"]; edges: GraphExportOutput["edges"]; total: number }
  | { ok: false; error: string };

export type OntologyNeighborsResult =
  | {
      ok: true;
      nodeId: string;
      found: boolean;
      neighbors: OntologyNeighborsOutput["neighbors"];
      truncated: boolean;
    }
  | { ok: false; error: string };

export type OntologyQueryResult =
  | {
      ok: true;
      startNode: OntologyQueryOutput["startNode"];
      nodes: OntologyQueryOutput["nodes"];
      edges: OntologyQueryOutput["edges"];
      truncated: boolean;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Shared IAM helper — apps/app never bootstraps IAM, so re-read the caller's
// workspace role from Postgres before every read/write. Owner + Member are
// treated as full access to the graph surface (Browse/Search/Query/Export);
// there is no "Viewer" carve-out here since run_cypher and export_graph are
// member-level-or-above per the task spec regardless of the individual
// contract's own defaultRoles.
// ---------------------------------------------------------------------------

async function assertWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<"ok" | "denied"> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  const role = rows[0]?.role ?? "";
  return ["owner", "member"].includes(role.toLowerCase()) ? "ok" : "denied";
}

function makeCtx(orgId: string, workspaceId: string, userId: string) {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

interface Gated {
  session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  org: Awaited<ReturnType<typeof resolveOrg>>;
  ws: Awaited<ReturnType<typeof resolveWorkspace>>;
}

/** Session + org resolution + org-membership IDOR guard (steps 1–3). */
async function resolveAndGate(orgSlug: string, workspaceSlug: string): Promise<Gated> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return { session, org, ws };
}

// ---------------------------------------------------------------------------
// listNodesAction — graph.node.list ("list_nodes"). Paginated Browse panel.
// ---------------------------------------------------------------------------

export async function listNodesAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  labels?: string[];
  isSystem?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
}): Promise<ListNodesResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to browse the graph." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("list_nodes", params, ctx, { surface: "agent" })) as GraphNodeListOutput;
      return {
        ok: true,
        nodes: out.nodes,
        total: out.total,
        hasMore: out.hasMore,
        limit: out.limit,
        offset: out.offset,
      };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: listNodesAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to list nodes." };
    }
  });
}

// ---------------------------------------------------------------------------
// searchNodesAction — graph.node.search ("search_nodes"). Fuzzy text search.
// ---------------------------------------------------------------------------

export async function searchNodesAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  query: string;
  labels?: string[];
  limit?: number;
}): Promise<SearchNodesResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to search the graph." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("search_nodes", params, ctx, { surface: "agent" })) as GraphNodeSearchOutput;
      return { ok: true, nodes: out.nodes };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: searchNodesAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to search nodes." };
    }
  });
}

// ---------------------------------------------------------------------------
// semanticSearchAction — graph.search ("search_graph"). NL/embedding search.
// ---------------------------------------------------------------------------

export async function semanticSearchAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  query: string;
  limit?: number;
  kinds?: Array<
    | "entity"
    | "file"
    | "symbol"
    | "chunk"
    | "memory"
    | "execution"
    | "document"
    | "message"
    | "asset"
  >;
  labels?: string[];
  isSystem?: boolean;
}): Promise<SemanticSearchResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to search the graph." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("search_graph", params, ctx, { surface: "agent" })) as GraphSearchOutput;
      return { ok: true, results: out.results };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: semanticSearchAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to run semantic search." };
    }
  });
}

// ---------------------------------------------------------------------------
// graphStatsAction — graph.stats ("get_graph_stats"). Panel-header summary
// counts, and (with includeByType) the label set that seeds Browse's filter
// chips — list_nodes itself has no "list distinct labels" capability, so the
// stats breakdown is the source of truth for which chips to offer.
// ---------------------------------------------------------------------------

export async function graphStatsAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  includeByType?: boolean;
}): Promise<GraphStatsResult> {
  const { orgSlug, workspaceSlug, includeByType } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to view graph stats." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke(
        "get_graph_stats",
        { ...(includeByType != null ? { includeByType } : {}) },
        ctx,
        { surface: "agent" },
      )) as GraphStatsOutput;
      const { render: _render, ...stats } = out;
      return { ok: true, stats };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: graphStatsAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to load graph stats." };
    }
  });
}

// ---------------------------------------------------------------------------
// runCypherAction — graph.cypher ("run_cypher"). Query console — raw Cypher
// or nlQuery=true natural-language translation. High-risk capability (the
// contract marks it agent.riskLevel "high" and defaultRoles workspace Owner
// only); per the task spec, treat as member-level here since apps/app is the
// sole IAM enforcement point.
// ---------------------------------------------------------------------------

export async function runCypherAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  query: string;
  nlQuery?: boolean;
  params?: Record<string, string | number | boolean>;
}): Promise<RunCypherResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to run graph queries." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("run_cypher", params, ctx, { surface: "agent" })) as GraphCypherOutput;
      return { ok: true, rows: out.rows, columns: out.columns, rowCount: out.rowCount };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: runCypherAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Query failed." };
    }
  });
}

// ---------------------------------------------------------------------------
// exportGraphAction — graph.export ("export_graph"). Subgraph export to file
// (client turns the returned nodes/edges into a downloaded JSON blob).
// NOTE surfaces: ["api","mcp"] only — invoke with { surface: "api" }, NOT
// "agent" (that would throw surface_denied).
// ---------------------------------------------------------------------------

export async function exportGraphAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  labels?: string[];
  isSystem?: boolean;
  updatedAfter?: string;
  includeEdges?: boolean;
  limit?: number;
  offset?: number;
}): Promise<ExportGraphResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to export the graph." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("export_graph", params, ctx, { surface: "api" })) as GraphExportOutput;
      return { ok: true, nodes: out.nodes, edges: out.edges, total: out.total };
    } catch (err) {
      logger.error({ err, orgId: org.id, workspaceId: ws.id }, "knowledge.graph: exportGraphAction failed");
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to export the graph." };
    }
  });
}

// ---------------------------------------------------------------------------
// ontologyNeighborsAction — ontology.neighbors ("get_ontology_neighbors").
// One-hop neighborhood expansion for a Browse-panel row.
// ---------------------------------------------------------------------------

export async function ontologyNeighborsAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
  edgeTypes?: string[];
  direction?: "out" | "in" | "both";
  limit?: number;
}): Promise<OntologyNeighborsResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to expand graph neighbors." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke(
        "get_ontology_neighbors",
        params,
        ctx,
        { surface: "agent" },
      )) as OntologyNeighborsOutput;
      return { ok: true, nodeId: out.nodeId, found: out.found, neighbors: out.neighbors, truncated: out.truncated };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, nodeId: input.nodeId },
        "knowledge.graph: ontologyNeighborsAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to expand neighbors." };
    }
  });
}

// ---------------------------------------------------------------------------
// ontologyQueryAction — ontology.query ("query_ontology"). Multi-hop
// traversal from the Query console's "Traverse" sub-mode.
// ---------------------------------------------------------------------------

export async function ontologyQueryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  startNodeId: string;
  edgeTypes?: string[];
  direction?: "out" | "in" | "both";
  maxDepth?: number;
  limit?: number;
}): Promise<OntologyQueryResult> {
  const { orgSlug, workspaceSlug, ...params } = input;
  const { session, org, ws } = await resolveAndGate(orgSlug, workspaceSlug);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to traverse the graph." };
    }

    const ctx = makeCtx(org.id, ws.id, session.user.id);

    try {
      const out = (await invoke("query_ontology", params, ctx, { surface: "agent" })) as OntologyQueryOutput;
      return { ok: true, startNode: out.startNode, nodes: out.nodes, edges: out.edges, truncated: out.truncated };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, startNodeId: input.startNodeId },
        "knowledge.graph: ontologyQueryAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to traverse the graph." };
    }
  });
}
