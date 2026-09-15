// search_tools: the command menu's search and the belt search outside a turn
// (MC spec §6.6, App. E). One ranked index over four kinds, at most eight
// rows. Tools come from the registry's agent surface, less plugin-claimed
// capabilities the org has not installed (`assistantBelt`); runs, agents and
// pending approvals from the workspace's own tables, each read inside the
// tenant scope the kernel entered and pinned to the org and workspace so a
// local stack with the RLS bypass on still answers for one workspace only.
// The in-app agent's own turns stay out of the run rows, as in list_runs.
// The eight slots are dealt across the kinds asked for, so no kind crowds
// the others out: the belt alone holds hundreds of tools.
import { schema, withTenantDb } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.list";
import {
  SEARCH_KINDS,
  SEARCH_ROW_LIMIT,
  type SearchKind,
  type SearchRow,
  type ToolsSearchInput,
  type ToolsSearchOutput,
} from "@oxagen/oxagen/contracts/tools.search";
import { and, desc, eq, ilike, isNull, notInArray, or, sql } from "drizzle-orm";
import { rankBelt } from "../runtime/tool-belt";
import type { CapabilityContext } from "../types";
import { assistantBelt } from "./tools.load";

const PER_KIND = SEARCH_ROW_LIMIT;

export async function toolsSearchHandler(
  input: ToolsSearchInput,
  ctx: CapabilityContext,
): Promise<ToolsSearchOutput> {
  const kinds = new Set<SearchKind>(input.kinds ?? SEARCH_KINDS);
  const query = input.query.trim();
  const pattern = `%${escapeLike(query)}%`;
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const [tools, records] = await Promise.all([
    kinds.has("tool") ? searchTools(ctx, query) : Promise.resolve([]),
    withTenantDb((tx) =>
      Promise.all([
        kinds.has("run") ? searchRuns(tx, scope, query, pattern) : [],
        kinds.has("agent") ? searchAgents(tx, scope, query, pattern) : [],
        kinds.has("approval") ? searchApprovals(tx, scope, query, pattern) : [],
      ]),
    ),
  ]);

  return { rows: dealAcrossKinds([tools, ...records], SEARCH_ROW_LIMIT) };
}

/**
 * Deal `limit` slots one per kind per round, in `SEARCH_KINDS` order, until
 * the slots or the rows run out; a kind with fewer rows leaves its slots to
 * the others. Rows keep their rank within a kind, and the kinds stay grouped.
 */
function dealAcrossKinds(groups: SearchRow[][], limit: number): SearchRow[] {
  const taken = groups.map(() => 0);
  let dealt = 0;
  let progressed = true;
  while (dealt < limit && progressed) {
    progressed = false;
    for (let i = 0; i < groups.length && dealt < limit; i += 1) {
      if (taken[i]! < groups[i]!.length) {
        taken[i]! += 1;
        dealt += 1;
        progressed = true;
      }
    }
  }
  return groups.flatMap((group, i) => group.slice(0, taken[i]));
}

async function searchTools(
  ctx: CapabilityContext,
  query: string,
): Promise<SearchRow[]> {
  const belt = await assistantBelt(ctx);
  const index = Object.fromEntries(
    belt.map((cap) => [cap.name, { description: cap.description }]),
  );
  return rankBelt(index as never, query, PER_KIND).map((row) => ({
    kind: "tool" as const,
    id: row.name,
    label: row.name,
    contextLine: row.description.length > 0 ? row.description : null,
  }));
}

type Scope = { orgId: string; workspaceId: string };
type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

async function searchRuns(
  tx: Tx,
  scope: Scope,
  query: string,
  pattern: string,
): Promise<SearchRow[]> {
  const runs = schema.agentRuns;
  const goal = sql<string | null>`${runs.spec}->>'goal'`;
  const ledger = await tx
    .select({
      publicId: runs.publicId,
      status: runs.status,
      goal,
      at: sql<Date>`coalesce(${runs.startedAt}, ${runs.createdAt})`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
        eq(runs.specVersion, 2),
        notInArray(runs.surface, [...IN_APP_AGENT_SURFACES]),
        query
          ? or(ilike(runs.publicId, pattern), ilike(goal, pattern))
          : undefined,
      ),
    )
    .orderBy(desc(sql`coalesce(${runs.startedAt}, ${runs.createdAt})`))
    .limit(PER_KIND);
  const sessions = schema.tachoSessions;
  const tacho = await tx
    .select({
      publicId: sessions.publicId,
      outcome: sessions.outcome,
      startedAt: sessions.startedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        isNull(sessions.parentSessionUuid),
        query ? ilike(sessions.publicId, pattern) : undefined,
      ),
    )
    .orderBy(desc(sessions.startedAt))
    .limit(PER_KIND);
  return [
    ...ledger.map((r) => ({
      kind: "run" as const,
      id: r.publicId,
      label: r.goal ?? r.publicId,
      contextLine: r.status,
    })),
    ...tacho.map((r) => ({
      kind: "run" as const,
      id: r.publicId,
      label: r.publicId,
      contextLine: r.outcome,
    })),
  ].slice(0, PER_KIND);
}

async function searchAgents(
  tx: Tx,
  scope: Scope,
  query: string,
  pattern: string,
): Promise<SearchRow[]> {
  const agents = schema.agents;
  const rows = await tx
    .select({
      publicId: agents.publicId,
      slug: agents.slug,
      name: agents.name,
      status: agents.status,
    })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, scope.orgId),
        eq(agents.workspaceId, scope.workspaceId),
        isNull(agents.deletedAt),
        query
          ? or(ilike(agents.slug, pattern), ilike(agents.name, pattern))
          : undefined,
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(PER_KIND);
  return rows.map((r) => ({
    kind: "agent" as const,
    id: r.publicId,
    label: r.name,
    contextLine: `${r.slug} · ${r.status}`,
  }));
}

async function searchApprovals(
  tx: Tx,
  scope: Scope,
  query: string,
  pattern: string,
): Promise<SearchRow[]> {
  const ar = schema.approvalRequests;
  const rows = await tx
    .select({
      publicId: ar.publicId,
      capabilityName: ar.capabilityName,
      expiresAt: ar.expiresAt,
    })
    .from(ar)
    .where(
      and(
        eq(ar.orgId, scope.orgId),
        eq(ar.workspaceId, scope.workspaceId),
        isNull(ar.resolution),
        sql`${ar.expiresAt} > now()`,
        query
          ? or(ilike(ar.publicId, pattern), ilike(ar.capabilityName, pattern))
          : undefined,
      ),
    )
    .orderBy(ar.expiresAt)
    .limit(PER_KIND);
  return rows.map((r) => ({
    kind: "approval" as const,
    id: r.publicId,
    label: r.capabilityName,
    contextLine: `expires ${r.expiresAt.toISOString()}`,
  }));
}

/** `%` and `_` in a query are characters, never wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
