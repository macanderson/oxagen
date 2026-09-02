/**
 * command.menu.search handler.
 *
 * Composes entity search results from:
 *   1. The ontology graph (KnowledgeNodes) via graph.node.search — covers any
 *      node label: ontology entities, ingested records projected as nodes, etc.
 *   2. Operational Postgres tables — runs, playbooks, triggers, agents,
 *      principals — each filtered by the caller's tenant via withTenantDb.
 *
 * Results are merged and sliced to 8 rows as per the spec (§10) performance
 * target. The dedupe is by href, so it only collapses repeats WITHIN a source —
 * the same entity found in Postgres and in the graph carries two different
 * routes (/activity/runs/… vs /knowledge/graph/…) and survives as two rows.
 *
 * Security: every Postgres query filters by ctx.orgId via withTenantDb
 * (RLS-enforced on the oxagen_app role) and, except for principals (which are
 * org-scoped by design), by ctx.workspaceId as well. The ontology arm inherits
 * the same scope through the search_nodes capability. No cross-tenant leakage
 * is possible even if the input kind/query is manipulated.
 */
import type { CapabilityHandler } from "@oxagen/oxagen";
import { commandMenuSearch } from "@oxagen/oxagen/contracts/command.menu.search";
import type {
  SearchResultRow,
  SearchableKind,
} from "@oxagen/oxagen/contracts/command.menu.search";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

// ── Route helpers ─────────────────────────────────────────────────────────────

function runHref(orgSlug: string, workspaceSlug: string, id: string): string {
  return `/${orgSlug}/${workspaceSlug}/activity/runs/${id}`;
}
function playbookHref(
  orgSlug: string,
  workspaceSlug: string,
  id: string,
): string {
  return `/${orgSlug}/${workspaceSlug}/automation/playbooks/${id}`;
}
function triggerHref(
  orgSlug: string,
  workspaceSlug: string,
  id: string,
): string {
  return `/${orgSlug}/${workspaceSlug}/automation/triggers/${id}`;
}
function agentHref(orgSlug: string, workspaceSlug: string, id: string): string {
  return `/${orgSlug}/${workspaceSlug}/agents/${id}`;
}
function principalHref(
  orgSlug: string,
  _workspaceSlug: string,
  id: string,
): string {
  return `/${orgSlug}/members/${id}`;
}

// ── Per-kind Postgres queries ─────────────────────────────────────────────────

async function searchRuns(
  orgId: string,
  workspaceId: string,
  query: string,
  orgSlug: string,
  workspaceSlug: string,
): Promise<SearchResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.agentExecutions.publicId,
        status: schema.agentExecutions.status,
        createdAt: schema.agentExecutions.createdAt,
      })
      .from(schema.agentExecutions)
      .where(
        and(
          eq(schema.agentExecutions.orgId, orgId),
          eq(schema.agentExecutions.workspaceId, workspaceId),
          query.trim()
            ? ilike(schema.agentExecutions.publicId, `%${query}%`)
            : undefined,
        ),
      )
      .orderBy(schema.agentExecutions.createdAt)
      .limit(8);
  });

  return rows.map((r) => ({
    kind: "run" as const,
    id: r.publicId,
    label: `Run ${r.publicId}`,
    scope: `Workspace: ${workspaceSlug}`,
    contextLine: `Status: ${r.status}`,
    href: runHref(orgSlug, workspaceSlug, r.publicId),
  }));
}

async function searchPlaybooks(
  orgId: string,
  workspaceId: string,
  query: string,
  orgSlug: string,
  workspaceSlug: string,
): Promise<SearchResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.playbooks.publicId,
        name: schema.playbooks.name,
        status: schema.playbooks.status,
      })
      .from(schema.playbooks)
      .where(
        and(
          eq(schema.playbooks.orgId, orgId),
          eq(schema.playbooks.workspaceId, workspaceId),
          isNull(schema.playbooks.deletedAt),
          query.trim()
            ? or(
                ilike(schema.playbooks.name, `%${query}%`),
                ilike(schema.playbooks.slug, `%${query}%`),
              )
            : undefined,
        ),
      )
      .limit(8);
  });

  return rows.map((r) => ({
    kind: "playbook" as const,
    id: r.publicId,
    label: r.name,
    scope: `Workspace: ${workspaceSlug}`,
    contextLine: `Status: ${r.status}`,
    href: playbookHref(orgSlug, workspaceSlug, r.publicId),
  }));
}

async function searchTriggers(
  orgId: string,
  workspaceId: string,
  query: string,
  orgSlug: string,
  workspaceSlug: string,
): Promise<SearchResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.playbookTriggers.publicId,
        triggerType: schema.playbookTriggers.triggerType,
        isEnabled: schema.playbookTriggers.isEnabled,
      })
      .from(schema.playbookTriggers)
      .where(
        and(
          eq(schema.playbookTriggers.orgId, orgId),
          eq(schema.playbookTriggers.workspaceId, workspaceId),
          query.trim()
            ? ilike(schema.playbookTriggers.triggerType, `%${query}%`)
            : undefined,
        ),
      )
      .limit(8);
  });

  return rows.map((r) => ({
    kind: "trigger" as const,
    id: r.publicId,
    label: r.triggerType,
    scope: `Workspace: ${workspaceSlug}`,
    contextLine: `${r.isEnabled ? "Enabled" : "Disabled"}`,
    href: triggerHref(orgSlug, workspaceSlug, r.publicId),
  }));
}

async function searchAgents(
  orgId: string,
  workspaceId: string,
  query: string,
  orgSlug: string,
  workspaceSlug: string,
): Promise<SearchResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.agents.publicId,
        name: schema.agents.name,
        status: schema.agents.status,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          eq(schema.agents.workspaceId, workspaceId),
          isNull(schema.agents.deletedAt),
          query.trim()
            ? or(
                ilike(schema.agents.name, `%${query}%`),
                ilike(schema.agents.slug, `%${query}%`),
              )
            : undefined,
        ),
      )
      .limit(8);
  });

  return rows.map((r) => ({
    kind: "agent" as const,
    id: r.publicId,
    label: r.name,
    scope: `Workspace: ${workspaceSlug}`,
    contextLine: `Status: ${r.status}`,
    href: agentHref(orgSlug, workspaceSlug, r.publicId),
  }));
}

async function searchPrincipals(
  orgId: string,
  _workspaceId: string,
  query: string,
  orgSlug: string,
  workspaceSlug: string,
): Promise<SearchResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.principals.publicId,
        displayName: schema.principals.displayName,
        kind: schema.principals.kind,
        status: schema.principals.status,
      })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          query.trim()
            ? or(
                ilike(schema.principals.displayName, `%${query}%`),
                ilike(schema.principals.idpSubject, `%${query}%`),
              )
            : undefined,
        ),
      )
      .limit(8);
  });

  return rows.map((r) => ({
    kind: "principal" as const,
    id: r.publicId,
    label: r.displayName,
    scope: `Org: ${orgSlug}`,
    contextLine: `${r.kind} · ${r.status}`,
    href: principalHref(orgSlug, workspaceSlug, r.publicId),
  }));
}

// ── Ontology search (graph.node.search) ──────────────────────────────────────

async function searchOntology(
  query: string,
  kind: SearchableKind | undefined,
  orgSlug: string,
  workspaceSlug: string,
  ctx: Parameters<typeof commandMenuSearchHandler>[1],
): Promise<SearchResultRow[]> {
  if (!query.trim()) return [];
  try {
    // Map entity kinds to Neo4j node labels used in the ontology.
    const labelMap: Partial<Record<SearchableKind, string>> = {
      run: "Run",
      playbook: "Playbook",
      trigger: "Trigger",
      agent: "Agent",
      event: "EventDef",
      principal: "Principal",
    };
    const labels =
      kind && labelMap[kind] ? [labelMap[kind] as string] : undefined;

    const result = (await invoke(
      "search_nodes",
      { query, labels, limit: 8 },
      ctx,
    )) as {
      nodes: Array<{
        nodeId: string;
        label: string;
        displayName: string;
        description: string | null;
      }>;
    };

    return result.nodes.map((n) => ({
      kind: (kind ?? "run") as SearchableKind, // best-effort kind
      id: n.nodeId,
      label: n.displayName,
      scope: `Workspace: ${workspaceSlug}`,
      contextLine: n.description ?? null,
      href: `/${orgSlug}/${workspaceSlug}/knowledge/graph/${n.nodeId}`,
    }));
  } catch {
    // Ontology search is best-effort — if Neo4j is unavailable, fall through
    // to operational results only.
    return [];
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const commandMenuSearchHandler: CapabilityHandler<
  typeof commandMenuSearch
> = async (input, ctx) => {
  const { kind, query, orgSlug, workspaceSlug } = input;
  const { orgId, workspaceId } = ctx;

  // Run all applicable searches in parallel; unknown kinds fall through to the
  // cross-kind graph search.
  const [graphRows, pgRows] = await Promise.all([
    searchOntology(query, kind, orgSlug, workspaceSlug, ctx),
    (async (): Promise<SearchResultRow[]> => {
      const wantKind = (k: SearchableKind) => !kind || kind === k;
      const results = await Promise.all([
        wantKind("run")
          ? searchRuns(orgId, workspaceId, query, orgSlug, workspaceSlug)
          : [],
        wantKind("playbook")
          ? searchPlaybooks(orgId, workspaceId, query, orgSlug, workspaceSlug)
          : [],
        wantKind("trigger")
          ? searchTriggers(orgId, workspaceId, query, orgSlug, workspaceSlug)
          : [],
        wantKind("agent")
          ? searchAgents(orgId, workspaceId, query, orgSlug, workspaceSlug)
          : [],
        wantKind("principal")
          ? searchPrincipals(orgId, workspaceId, query, orgSlug, workspaceSlug)
          : [],
      ]);
      return results.flat();
    })(),
  ]);

  // Merge: Postgres results first (more precise), then ontology results whose
  // href has not already been emitted.
  const seen = new Set<string>();
  const merged: SearchResultRow[] = [];
  for (const row of [...pgRows, ...graphRows]) {
    if (!seen.has(row.href)) {
      seen.add(row.href);
      merged.push(row);
    }
  }

  const rows = merged.slice(0, 8);

  logger.info(
    { orgId, workspaceId, kind, query, resultCount: rows.length },
    "command.menu.search: search completed",
  );

  return { rows };
};
