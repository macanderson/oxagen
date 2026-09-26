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
import { TAMPER_INCIDENT_KINDS } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
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
  /**
   * `agent.agents.agent_type`. `isManagedAgentType` reads it: the workspace's
   * built-in assistant (`qa-chat`) is Oxagen's, and no identity write may
   * retire, suspend, or mint a credential for it.
   */
  agentType: string;
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
  /** The operator's display name, from the same user row as `operatorPublicId`. */
  operatorName: string | null;
  /** The label set through set_cost_center (ADR-142); null inherits the workspace's. */
  costCenter: string | null;
  /** The runtime the agent runs on now (ADR-192); null when it runs on no named runtime. */
  runtimeId: string | null;
  /** The toolbelt the agent carries now; null reads as the workspace's All tools belt. */
  toolbeltId: string | null;
}

const identityColumns = {
  id: schema.agents.id,
  publicId: schema.agents.publicId,
  slug: schema.agents.slug,
  name: schema.agents.name,
  description: schema.agents.description,
  harness: schema.agents.harness,
  agentType: schema.agents.agentType,
  status: schema.agents.status,
  createdAt: schema.agents.createdAt,
  updatedAt: schema.agents.updatedAt,
  principalId: schema.agents.principalId,
  principalPublicId: schema.principals.publicId,
  principalStatus: schema.principals.status,
  principalUpdatedAt: schema.principals.updatedAt,
  operatorPublicId: schema.users.publicId,
  operatorName: schema.users.displayName,
  costCenter: schema.agents.costCenter,
  runtimeId: schema.agents.runtimeId,
  toolbeltId: schema.agents.toolbeltId,
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

/**
 * A page of agents by slug, after `afterSlug` when given. A retired
 * (`archived`) agent is left out unless `includeRetired` is set, because a
 * deregistered agent is a deleted record everywhere but the view that asks
 * for it.
 */
export async function listAgentIdentities(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  page: {
    limit: number;
    afterSlug: string | undefined;
    includeRetired?: boolean;
  },
): Promise<AgentIdentityRow[]> {
  return identitySelect(tx)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        isNull(schema.agents.deletedAt),
        page.includeRetired === true
          ? undefined
          : ne(schema.agents.status, "archived"),
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
 * The hostname of each agent key's live host seen most recently. A host that
 * has never reported ranks after one that has, then the newest enrollment.
 */
export async function latestLiveHostByAgentKey(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
): Promise<Map<string, string>> {
  if (agentKeys.length === 0) return new Map();
  const h = schema.tachoHosts;
  const rows = await tx
    .selectDistinctOn([h.agentKey], {
      agentKey: h.agentKey,
      hostname: h.hostname,
    })
    .from(h)
    .where(
      and(
        eq(h.orgId, scope.orgId),
        eq(h.workspaceId, scope.workspaceId),
        inArray(h.agentKey, [...agentKeys]),
        inArray(h.status, [...HOST_LIVE_STATUSES]),
      ),
    )
    .orderBy(
      h.agentKey,
      sql`${h.lastSeenAt} desc nulls last`,
      desc(h.createdAt),
    );
  return new Map(rows.map((r) => [r.agentKey, r.hostname]));
}

/**
 * Active mandates per agent principal (uuid) in the scope's workspace: status
 * `active` and inside the validity window, which is what the mandate gate
 * reads. A draft, an expired or a revoked mandate authorizes nothing.
 */
export async function activeMandatesByPrincipal(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  principalIds: readonly string[],
): Promise<Map<string, number>> {
  if (principalIds.length === 0) return new Map();
  const m = schema.mandates;
  const rows = await tx
    .select({
      principalId: m.agentPrincipalId,
      count: sql<number>`count(*)::int`,
    })
    .from(m)
    .where(
      and(
        eq(m.orgId, scope.orgId),
        eq(m.workspaceId, scope.workspaceId),
        inArray(m.agentPrincipalId, [...principalIds]),
        eq(m.status, "active"),
        sql`${m.validFrom} <= now()`,
        sql`${m.validTo} > now()`,
      ),
    )
    .groupBy(m.agentPrincipalId);
  return new Map(rows.map((r) => [r.principalId, r.count]));
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
  /**
   * The enforcement tier the latest root wrapped session recorded, ignoring
   * the window; null when no wrapped session was recorded.
   */
  latestTier: string | null;
  /**
   * The tokens the agent's root wrapped sessions in the window reported, as
   * the harness counted them; null when no session in the window reported
   * a token. Ledger runs' tokens are metered in ClickHouse and are not rolled
   * up per agent, so they are not in this total.
   */
  tokens?: WrappedTokenFigures | null;
}

/**
 * A wrapped-session token rollup. `input` is every input token the model
 * read, fresh, cache read and cache written, because the harness reports
 * `input_tokens` without the cached classes (Anthropic usage semantics), and
 * `total` adds the output. `cacheReadRate` is cache read over that input;
 * null when no input was reported.
 */
export interface WrappedTokenFigures {
  total: number;
  input: number;
  cacheRead: number;
  cacheReadRate: number | null;
  /** Root sessions in the window that reported at least one token. */
  sessions: number;
}

/** The rollup from the four summed columns; null when no session reported a token. */
export function wrappedTokenFigures(sums: {
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}): WrappedTokenFigures | null {
  if (sums.sessions === 0) return null;
  const input = sums.input + sums.cacheRead + sums.cacheCreation;
  return {
    total: input + sums.output,
    input,
    cacheRead: sums.cacheRead,
    cacheReadRate: input === 0 ? null : sums.cacheRead / input,
    sessions: sums.sessions,
  };
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
  const inWindow = sql`${s.startedAt} >= ${since}`;
  // A session that reported no token at all is a harness that does not
  // report usage, not a session that used none.
  const reported = sql`(${s.inputTokens} + ${s.outputTokens} + ${s.cacheReadTokens} + ${s.cacheCreationTokens}) > 0`;
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
            latestTier: sql<
              string | null
            >`(array_agg(${s.enforcementTier} order by ${s.startedAt} desc nulls last))[1]`,
            tokenSessions: sql<number>`count(*) filter (where ${inWindow} and ${reported})::int`,
            inputTokens: sql<string>`coalesce(sum(${s.inputTokens}) filter (where ${inWindow}), 0)::text`,
            outputTokens: sql<string>`coalesce(sum(${s.outputTokens}) filter (where ${inWindow}), 0)::text`,
            cacheReadTokens: sql<string>`coalesce(sum(${s.cacheReadTokens}) filter (where ${inWindow}), 0)::text`,
            cacheCreationTokens: sql<string>`coalesce(sum(${s.cacheCreationTokens}) filter (where ${inWindow}), 0)::text`,
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
      latestTier: w?.latestTier ?? null,
      tokens: w
        ? wrappedTokenFigures({
            sessions: w.tokenSessions,
            input: Number(w.inputTokens),
            output: Number(w.outputTokens),
            cacheRead: Number(w.cacheReadTokens),
            cacheCreation: Number(w.cacheCreationTokens),
          })
        : null,
    });
  }
  return out;
}

/**
 * Open incidents per agent key, through the hosts enrolled under it. With
 * `tamperOnly`, only the kinds `TAMPER_INCIDENT_KINDS` names, which is the set
 * the workspace tile and the Audit page count.
 */
export async function openIncidentsByAgentKey(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
  tamperOnly = false,
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
        tamperOnly
          ? inArray(schema.tachoIncidents.kind, [...TAMPER_INCIDENT_KINDS])
          : undefined,
      ),
    )
    .groupBy(schema.tachoHosts.agentKey);
  return new Map(rows.map((r) => [r.agentKey, r.count]));
}

/** Tamper incidents on one agent key's hosts: every one the store keeps, and the open ones. */
export interface TamperCounts {
  recorded: number;
  open: number;
}

/**
 * Tamper incidents per agent key, through the hosts enrolled under it: every
 * incident of a tamper kind the store keeps (its retention window), and how
 * many of them are open. The Incidents column, the Health cell and the
 * Tamper incidents tile all read this one set, so the tile is the sum of the
 * rows.
 */
export async function tamperIncidentsByAgentKey(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
): Promise<Map<string, TamperCounts>> {
  if (agentKeys.length === 0) return new Map();
  const rows = await tx
    .select({
      agentKey: schema.tachoHosts.agentKey,
      recorded: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${schema.tachoIncidents.resolvedAt} is null)::int`,
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
        inArray(schema.tachoHosts.agentKey, [...agentKeys]),
        inArray(schema.tachoIncidents.kind, [...TAMPER_INCIDENT_KINDS]),
      ),
    )
    .groupBy(schema.tachoHosts.agentKey);
  return new Map(
    rows.map((r) => [r.agentKey, { recorded: r.recorded, open: r.open }]),
  );
}

/** The newest tamper incident on any of these agent keys' hosts; null when there is none. */
export async function newestTamperIncident(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKeys: readonly string[],
): Promise<{ agentKey: string; kind: string; detectedAt: Date } | null> {
  if (agentKeys.length === 0) return null;
  const [row] = await tx
    .select({
      agentKey: schema.tachoHosts.agentKey,
      kind: schema.tachoIncidents.kind,
      detectedAt: schema.tachoIncidents.detectedAt,
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
        inArray(schema.tachoHosts.agentKey, [...agentKeys]),
        inArray(schema.tachoIncidents.kind, [...TAMPER_INCIDENT_KINDS]),
      ),
    )
    .orderBy(desc(schema.tachoIncidents.detectedAt))
    .limit(1);
  return row ?? null;
}

/** A runtime as a record names it (ADR-192). */
export interface RuntimeRefRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
}

/** A toolbelt as a record names it (ADR-192). */
export interface ToolbeltRefRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  kind: "all_tools" | "custom";
}

/**
 * The runtimes and toolbelts a set of rows names, by internal id, plus the
 * workspace's All tools belt, which a null `toolbelt_id` reads as. A soft-
 * deleted runtime or belt still resolves: an agent version that named one
 * keeps naming it. This read writes nothing, so a workspace no toolbelt path
 * has touched yet answers `allTools: null`.
 */
export async function bindingRefs(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  ids: {
    runtimeIds: readonly (string | null)[];
    toolbeltIds: readonly (string | null)[];
  },
): Promise<{
  runtimes: Map<string, RuntimeRefRow>;
  toolbelts: Map<string, ToolbeltRefRow>;
  allTools: ToolbeltRefRow | null;
}> {
  const runtimeIds = [
    ...new Set(ids.runtimeIds.filter((id): id is string => id !== null)),
  ];
  const toolbeltIds = [
    ...new Set(ids.toolbeltIds.filter((id): id is string => id !== null)),
  ];
  const runtimes = new Map<string, RuntimeRefRow>();
  if (runtimeIds.length > 0) {
    const rows = await tx
      .select({
        id: schema.runtimes.id,
        publicId: schema.runtimes.publicId,
        name: schema.runtimes.name,
        slug: schema.runtimes.slug,
      })
      .from(schema.runtimes)
      .where(
        and(
          eq(schema.runtimes.orgId, scope.orgId),
          eq(schema.runtimes.workspaceId, scope.workspaceId),
          inArray(schema.runtimes.id, runtimeIds),
        ),
      );
    for (const row of rows) runtimes.set(row.id, row);
  }
  const t = schema.toolbelts;
  const beltColumns = {
    id: t.id,
    publicId: t.publicId,
    name: t.name,
    slug: t.slug,
    kind: t.kind,
  };
  const toolbelts = new Map<string, ToolbeltRefRow>();
  if (toolbeltIds.length > 0) {
    const rows = await tx
      .select(beltColumns)
      .from(t)
      .where(
        and(
          eq(t.orgId, scope.orgId),
          eq(t.workspaceId, scope.workspaceId),
          inArray(t.id, toolbeltIds),
        ),
      );
    for (const row of rows) toolbelts.set(row.id, toToolbeltRef(row));
  }
  const [allToolsRow] = await tx
    .select(beltColumns)
    .from(t)
    .where(
      and(
        eq(t.orgId, scope.orgId),
        eq(t.workspaceId, scope.workspaceId),
        eq(t.kind, "all_tools"),
        isNull(t.deletedAt),
      ),
    )
    .limit(1);
  return {
    runtimes,
    toolbelts,
    allTools: allToolsRow ? toToolbeltRef(allToolsRow) : null,
  };
}

function toToolbeltRef(row: {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  kind: string;
}): ToolbeltRefRow {
  return { ...row, kind: row.kind === "all_tools" ? "all_tools" : "custom" };
}

/** The contract shape of a runtime reference. */
export function runtimeRef(
  row: RuntimeRefRow | undefined,
): { id: string; name: string; slug: string } | null {
  return row ? { id: row.publicId, name: row.name, slug: row.slug } : null;
}

/** The contract shape of a toolbelt reference. */
export function toolbeltRef(row: ToolbeltRefRow | null | undefined): {
  id: string;
  name: string;
  slug: string;
  kind: "all_tools" | "custom";
} | null {
  return row
    ? { id: row.publicId, name: row.name, slug: row.slug, kind: row.kind }
    : null;
}
