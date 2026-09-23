// _agent-identity.ts — the identity half of an agent, read from Postgres
// (MC spec §6.2 "Identity in Postgres, definition in git"; #2956).
//
// An agent identity is the `agent.agents` row, its delegated `iam.principals`
// row and the things that must be revocable in one second: the long-lived
// credentials in `auth.api_keys` (scope purpose `agent_credential_v1`) and the
// hosts enrolled under its agent key in `tacho.hosts`. This module resolves
// them together and derives the identity's status from them; `list_agents`
// and `get_agent` read through it so the two never disagree on what
// "enrolled" means.
import { agentCreatorUserJoin, schema, type Tx } from "@oxagen/database";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import type { AgentIdentityStatus } from "@oxagen/oxagen/contracts/agent.list";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  composeAgentKey,
  isUuid,
  resolveNamespacePrefix,
} from "./_agent-definition";

const HOST_LIVE_STATUSES = ["active", "paused"] as const;

export interface AgentIdentityRow {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  description: string | null;
  harness: string;
  status: string;
  createdAt: Date;
  /** The last identity write; for an archived agent, the retirement. */
  updatedAt: Date;
  principalId: string | null;
  principalPublicId: string | null;
  principalStatus: string | null;
  /** The principal's last write; a suspend or resume is one of them. */
  principalUpdatedAt: Date | null;
  operatorPublicId: string | null;
  /** The label set through set_cost_center (ADR-142); null inherits the workspace's. */
  costCenter: string | null;
}

const identityColumns = {
  id: schema.agents.id,
  publicId: schema.agents.publicId,
  slug: schema.agents.slug,
  name: schema.agents.name,
  description: schema.agents.description,
  harness: schema.agents.harness,
  status: schema.agents.status,
  createdAt: schema.agents.createdAt,
  updatedAt: schema.agents.updatedAt,
  principalId: schema.agents.principalId,
  principalPublicId: schema.principals.publicId,
  principalStatus: schema.principals.status,
  principalUpdatedAt: schema.principals.updatedAt,
  operatorPublicId: schema.users.publicId,
  costCenter: schema.agents.costCenter,
} as const;

function identitySelect(tx: Tx) {
  return (
    tx
      .select(identityColumns)
      .from(schema.agents)
      .leftJoin(
        schema.principals,
        and(
          eq(schema.principals.id, schema.agents.principalId),
          eq(schema.principals.orgId, schema.agents.orgId),
        ),
      )
      // The relations seam, not an inline condition (AGENTS.md: cross-domain
      // joins live in `src/relations.ts`).
      //
      // `agentCreatorUserJoin`, not `operatorUserJoin`. This row's principal is
      // the agent's own, which is `kind = 'agent'`, and its `parent_user_id` is
      // the user who created it — the person `operatorId` names here. The run
      // join carries `kind = 'human'` for a different question, so pointing it
      // at this one matched nothing and every agent reported no operator.
      .leftJoin(schema.users, agentCreatorUserJoin)
  );
}

/** One live agent by public id (`agt_…`), uuid or slug, in the scope's workspace. */
export async function resolveAgentIdentity(
  tx: Tx,
  identifier: string,
  scope: { orgId: string; workspaceId: string },
): Promise<AgentIdentityRow | null> {
  const match = isUuid(identifier)
    ? eq(schema.agents.id, identifier)
    : identifier.startsWith("agt_")
      ? eq(schema.agents.publicId, identifier)
      : eq(schema.agents.slug, identifier);
  const [row] = await identitySelect(tx)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        match,
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A page of live agents by slug, after `afterSlug` when given. */
export async function listAgentIdentities(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  page: { limit: number; afterSlug: string | undefined },
): Promise<AgentIdentityRow[]> {
  return identitySelect(tx)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        isNull(schema.agents.deletedAt),
        page.afterSlug === undefined
          ? undefined
          : gt(schema.agents.slug, page.afterSlug),
      ),
    )
    .orderBy(schema.agents.slug)
    .limit(page.limit);
}

/** The agent keys of a set of identities, from the scope's namespaces. */
export async function agentKeysFor(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  rows: readonly AgentIdentityRow[],
): Promise<Map<string, string | null>> {
  const { orgNamespace, workspaceNamespace } = await resolveNamespacePrefix(
    tx,
    scope.orgId,
    scope.workspaceId,
  );
  return new Map(
    rows.map((r) => [
      r.id,
      composeAgentKey(orgNamespace, workspaceNamespace, r.slug),
    ]),
  );
}

/** Active (not soft-deleted, not expired) credentials per agent public id. */
export async function activeCredentialsByAgent(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentPublicIds: readonly string[],
): Promise<Map<string, number>> {
  if (agentPublicIds.length === 0) return new Map();
  const agentId = sql<string>`${schema.apiKeys.scope}->>'agent_id'`;
  const rows = await tx
    .select({ agentId, count: sql<number>`count(*)::int` })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.orgId, scope.orgId),
        eq(schema.apiKeys.workspaceId, scope.workspaceId),
        sql`${schema.apiKeys.scope}->>'purpose' = ${AGENT_CREDENTIAL_SCOPE_PURPOSE}`,
        inArray(agentId, [...agentPublicIds]),
        isNull(schema.apiKeys.deletedAt),
        or(
          isNull(schema.apiKeys.expiresAt),
          gt(schema.apiKeys.expiresAt, sql`now()`),
        ),
      ),
    )
    .groupBy(agentId);
  return new Map(rows.map((r) => [r.agentId, r.count]));
}

/** Live (active or paused) hosts per agent key. */
export async function liveHostsByAgentKey(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
): Promise<Map<string, number>> {
  if (agentKeys.length === 0) return new Map();
  const rows = await tx
    .select({
      agentKey: schema.tachoHosts.agentKey,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.tachoHosts)
    .where(
      and(
        eq(schema.tachoHosts.orgId, scope.orgId),
        eq(schema.tachoHosts.workspaceId, scope.workspaceId),
        inArray(schema.tachoHosts.agentKey, [...agentKeys]),
        inArray(schema.tachoHosts.status, [...HOST_LIVE_STATUSES]),
      ),
    )
    .groupBy(schema.tachoHosts.agentKey);
  return new Map(rows.map((r) => [r.agentKey, r.count]));
}

/**
 * The identity's state (contract `agentIdentityStatusSchema`). Archived
 * wins over suspended: a retired agent's principal is suspended too.
 */
export function identityStatus(
  row: Pick<AgentIdentityRow, "status" | "principalStatus">,
  held: { credentials: number; hosts: number },
): AgentIdentityStatus {
  if (row.status === "archived") return "retired";
  if (row.principalStatus === "suspended") return "suspended";
  return held.credentials > 0 || held.hosts > 0 ? "enrolled" : "unenrolled";
}

export interface RunWindowFigures {
  runs: number;
  /** Sum of priced wrapped sessions' `total_cost_micros`; null when none was priced. */
  spendMicros: bigint | null;
  earliestStartedAt: Date | null;
}

/**
 * Runs the two run stores recorded for these agents: ledger runs by agent
 * row, root wrapped sessions by agent key. `windowStart` bounds the count and
 * the spend; the earliest start ignores the window.
 */
export async function runFiguresByAgent(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agents: readonly { id: string; agentKey: string | null }[],
  windowStart: Date,
): Promise<Map<string, RunWindowFigures>> {
  const out = new Map<string, RunWindowFigures>();
  if (agents.length === 0) return out;
  const ids = agents.map((a) => a.id);
  const keys = agents.flatMap((a) => (a.agentKey ? [a.agentKey] : []));
  const since = sql`${windowStart.toISOString()}::timestamptz`;

  const ledger = await tx
    .select({
      agentId: schema.agentRuns.agentId,
      runs: sql<number>`count(*) filter (where coalesce(${schema.agentRuns.startedAt}, ${schema.agentRuns.createdAt}) >= ${since})::int`,
      earliest:
        sql<Date | null>`min(coalesce(${schema.agentRuns.startedAt}, ${schema.agentRuns.createdAt}))`.mapWith(
          (v: unknown) => (v === null ? null : new Date(v as string)),
        ),
    })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.orgId, scope.orgId),
        eq(schema.agentRuns.workspaceId, scope.workspaceId),
        inArray(schema.agentRuns.agentId, ids),
      ),
    )
    .groupBy(schema.agentRuns.agentId);

  const s = schema.tachoSessions;
  const priced = sql`${s.costBasis} is not null and ${s.costBasis} <> 'unknown' and coalesce(${s.hasUnknownModelCost}, false) = false and ${s.startedAt} >= ${since}`;
  const wrapped =
    keys.length === 0
      ? []
      : await tx
          .select({
            agentKey: s.agentKey,
            runs: sql<number>`count(*) filter (where ${s.startedAt} >= ${since})::int`,
            pricedRuns: sql<number>`count(*) filter (where ${priced})::int`,
            spend: sql<string>`coalesce(sum(${s.totalCostMicros}) filter (where ${priced}), 0)::text`,
            earliest: sql<Date | null>`min(${s.startedAt})`.mapWith(
              (v: unknown) => (v === null ? null : new Date(v as string)),
            ),
          })
          .from(s)
          .where(
            and(
              eq(s.orgId, scope.orgId),
              eq(s.workspaceId, scope.workspaceId),
              inArray(s.agentKey, keys),
              isNull(s.parentSessionUuid),
            ),
          )
          .groupBy(s.agentKey);

  const byKey = new Map(wrapped.map((w) => [w.agentKey, w]));
  const byId = new Map(ledger.map((l) => [l.agentId, l]));
  for (const agent of agents) {
    const l = byId.get(agent.id);
    const w = agent.agentKey ? byKey.get(agent.agentKey) : undefined;
    const starts = [l?.earliest ?? null, w?.earliest ?? null].filter(
      (d): d is Date => d !== null,
    );
    out.set(agent.id, {
      runs: (l?.runs ?? 0) + (w?.runs ?? 0),
      spendMicros: w && w.pricedRuns > 0 ? BigInt(w.spend) : null,
      earliestStartedAt:
        starts.length === 0
          ? null
          : new Date(Math.min(...starts.map((d) => d.getTime()))),
    });
  }
  return out;
}

/** Open incidents per agent key, through the hosts enrolled under it. */
export async function openIncidentsByAgentKey(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
): Promise<Map<string, number>> {
  if (agentKeys.length === 0) return new Map();
  const rows = await tx
    .select({
      agentKey: schema.tachoHosts.agentKey,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.tachoIncidents)
    .innerJoin(
      schema.tachoHosts,
      and(
        eq(schema.tachoHosts.id, schema.tachoIncidents.hostId),
        eq(schema.tachoHosts.orgId, schema.tachoIncidents.orgId),
      ),
    )
    .where(
      and(
        eq(schema.tachoIncidents.orgId, scope.orgId),
        eq(schema.tachoIncidents.workspaceId, scope.workspaceId),
        isNull(schema.tachoIncidents.resolvedAt),
        inArray(schema.tachoHosts.agentKey, [...agentKeys]),
      ),
    )
    .groupBy(schema.tachoHosts.agentKey);
  return new Map(rows.map((r) => [r.agentKey, r.count]));
}
