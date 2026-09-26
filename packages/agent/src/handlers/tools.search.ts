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
import {
  hidesWitnessRuns,
  notWitnessRun,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.list";
import {
  SEARCH_KINDS,
  SEARCH_ROW_LIMIT,
  type SearchKind,
  type SearchRow,
  type ToolsSearchInput,
  type ToolsSearchOutput,
} from "@oxagen/oxagen/contracts/tools.search";
import {
  and,
  desc,
  eq,
  ilike,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  resolveActingUserId,
  resolveActorOrgRoles,
  resolveActorWorkspaceRoles,
} from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { rankBelt } from "../runtime/tool-belt";
import { maySeeKind, SEARCH_KIND_ROLES } from "./search-kind-roles";
import type { CapabilityContext } from "../types";
import { assistantBelt } from "./tools.load";

const PER_KIND = SEARCH_ROW_LIMIT;

export async function toolsSearchHandler(
  input: ToolsSearchInput,
  ctx: CapabilityContext,
): Promise<ToolsSearchOutput> {
  const asked = new Set<SearchKind>(input.kinds ?? SEARCH_KINDS);
  // Per-kind authorization. This handler reads the run, agent and approval
  // tables directly instead of invoking the capabilities that own them, so
  // its own (broader) roles were the only gate: a workspace Viewer is allowed
  // search_tools and denied list_runs and list_agents. Each kind is now
  // answered only to an actor the SOURCE capability's contract admits.
  const kinds = await permittedKinds(asked, ctx);
  if (kinds.size === 0) {
    // Narrowing to nothing is only reachable when the caller named kinds and
    // holds none of them. Answering `rows: []` there would mean "forbidden"
    // dressed as "no matches", which is the fabricated-empty this repo bans,
    // so it is a refusal. A caller who named no kinds always keeps `tool`.
    throw new HandlerError({
      code: "forbidden",
      reason: "kind_not_permitted",
      message: `not permitted to search: ${[...asked].sort().join(", ")}`,
    });
  }
  const query = input.query.trim();
  const pattern = `%${escapeLike(query)}%`;
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const [tools, records] = await Promise.all([
    kinds.has("tool") ? searchTools(ctx, query) : Promise.resolve([]),
    withTenantDb((tx) =>
      Promise.all([
        kinds.has("run")
          ? searchRuns(tx, scope, query, pattern, hidesWitnessRuns(ctx))
          : [],
        kinds.has("agent") ? searchAgents(tx, scope, query, pattern) : [],
        kinds.has("approval") ? searchApprovals(tx, scope, query, pattern) : [],
      ]),
    ),
  ]);

  return { rows: dealAcrossKinds([tools, ...records], SEARCH_ROW_LIMIT) };
}

/**
 * The subset of `asked` this caller may see. Roles are resolved once and the
 * per-kind lists come from each source capability's contract
 * (`SEARCH_KIND_ROLES`), so tightening `list_runs` tightens search with it.
 *
 * An API-key call acts as the key's creator (ADR-079), the same rule the rest
 * of this branch applies, so a key carries its creator's current roles and no
 * more. No resolvable actor keeps only the kinds that need no source
 * capability, which is `tool` — it fails closed.
 */
async function permittedKinds(
  asked: ReadonlySet<SearchKind>,
  ctx: CapabilityContext,
): Promise<Set<SearchKind>> {
  const needsRoles = [...asked].some((k) => SEARCH_KIND_ROLES[k]);
  if (!needsRoles) return new Set(asked);
  const userId = await resolveActingUserId({
    orgId: ctx.orgId,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
  });
  if (!userId) {
    return new Set([...asked].filter((k) => !SEARCH_KIND_ROLES[k]));
  }
  const [orgRoles, workspaceRoles] = await Promise.all([
    resolveActorOrgRoles(ctx.orgId, userId),
    resolveActorWorkspaceRoles(ctx.orgId, ctx.workspaceId, userId),
  ]);
  const actor = { orgRoles, workspaceRoles };
  return new Set([...asked].filter((k) => maySeeKind(k, actor)));
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
  hideWitnesses: boolean,
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
        // Same exclusion list_runs applies (ADR-064) and for the same reason:
        // an API-key caller is a worker, and a run a verdict names as its
        // witness run is what checked that worker. The predicate is shared,
        // not copied — see notWitnessRun in @oxagen/database.
        hideWitnesses ? notWitnessRun(runs) : undefined,
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
        hideWitnesses ? notWitnessRun(sessions) : undefined,
        query ? ilike(sessions.publicId, pattern) : undefined,
      ),
    )
    .orderBy(desc(sessions.startedAt))
    .limit(PER_KIND);
  // Both stores hold runs and each answered its own newest PER_KIND. Taking
  // the ledger's rows first and slicing would drop every Tacho session
  // whenever PER_KIND ledger runs matched, however much newer the session
  // was; the run kind has to be the newest runs across both stores, so carry
  // each row's timestamp, merge on it, and slice once at the end.
  return [
    ...ledger.map((r) => ({
      at: r.at,
      row: {
        kind: "run" as const,
        id: r.publicId,
        label: r.goal ?? r.publicId,
        contextLine: r.status,
      },
    })),
    ...tacho.map((r) => ({
      at: r.startedAt,
      row: {
        kind: "run" as const,
        id: r.publicId,
        label: r.publicId,
        contextLine: r.outcome,
      },
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, PER_KIND)
    .map((r) => r.row);
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
        // Treat a retired agent as a deleted record, so the menu never offers it.
        ne(agents.status, "archived"),
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
