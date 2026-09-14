// The live agents adapter (Batch 3 lane A3): Agents list, agent detail,
// toolbelt, definition and incidents from today's stores.
//
// Reads that exist as agent tools go through the kernel as the signed-in person
// (list_agent_defs, get_agent_def, list_agent_roles, list_iam_roles,
// list_tacho_hosts), so IAM decides and audits them exactly as on the API. The
// stores no agent tool exposes (iam.principals, tacho.hosts device and
// credential facts, tacho.sessions tiers, tacho.incidents) are read with
// withTenantDb inside runInTenantScope, and only after the agent tools above
// have let the person see the agent. RLS is not relied on: it passes everything
// through wherever TENANT_RLS_ENFORCEMENT_ENABLED is off (packages/tenancy
// README), and tacho.hosts.agent_key is caller-supplied at enrollment, so
// another tenant can hold the same key. Every tenant table in every such read
// keeps its own org (and workspace) predicate. Every result is
// parsed through its view-model schema before it leaves.
//
// A method whose view model cannot carry what the stores record (a field with
// no column, today's role names, collector incident kinds) stays not-backed:
// `LIVE_READINESS` asks each schema whether it accepts the mappers' probe rows,
// once, at load. Relaxing the view model turns the method live with no change
// here. Mandates (G1) and scores (G11) have no store at all.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { agentDefinitionGet } from "@oxagen/oxagen/contracts/agent.definition.get";
import { agentDefinitionList } from "@oxagen/oxagen/contracts/agent.definition.list";
import {
  type AgentRoleListOutput,
  agentRoleList,
} from "@oxagen/oxagen/contracts/agent.role.list";
import {
  type IamRoleRow,
  iamRoleList,
} from "@oxagen/oxagen/contracts/iam.role.list";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, inArray, isNull, min, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { notBackedFor } from "@/data/backing";
import {
  AgentDefinition,
  AgentDetail,
  AgentRow,
  EnforcementTier,
  Incident,
  Toolbelt,
} from "@/data/contracts";
import { denied, type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { AgentReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  type AgentSource,
  type DefinitionRow,
  type HostFacts,
  type HostSummary,
  type IncidentRow,
  type PrincipalFacts,
  RECORDED_PROBES,
  rejectedPaths,
  toAgentDefinition,
  toAgentDetail,
  toAgentRow,
  toIncident,
  toToolbelt,
} from "./mappers/agents";

/** What the live agents adapter reads. `liveAgentStores` is the real one. */
export type AgentStores = {
  /** An agent tool read as the signed-in person, parsed with the tool's own output schema. */
  readTool<O>(
    scope: Scope,
    contract: ToolContract<unknown, O>,
    input: unknown,
  ): Promise<Read<O>>;
  /** The registered agent tool's description, or null when none is registered. */
  describeTool(name: string): string | null;
  workspaceSlug(scope: Scope): Promise<string | null>;
  /** Principal facts keyed by `agent.agents.public_id` (list_agent_defs' agentId). */
  principals(
    scope: Scope,
    agentPublicIds: readonly string[],
  ): Promise<Map<string, PrincipalFacts>>;
  /** The latest run's recorded tier, keyed by agent key. */
  latestTiers(
    scope: Scope,
    keys: readonly string[],
  ): Promise<Map<string, EnforcementTier>>;
  /**
   * Unresolved `tacho.incidents` per agent key, linked by its host or by one of
   * its runs. A key with none is absent from the map.
   */
  openIncidents(
    scope: Scope,
    keys: readonly string[],
  ): Promise<Map<string, number>>;
  hostFacts(scope: Scope, key: string): Promise<HostFacts | null>;
  incidents(scope: Scope, key: string): Promise<IncidentRow[]>;
};

type ServedMethod = "listAgents" | "getAgent" | "toolbelt" | "incidents";
export type LiveReadiness = Record<ServedMethod, boolean>;

/** Whether each view model carries what the stores record today (see file header). */
export const LIVE_READINESS: LiveReadiness = {
  listAgents:
    rejectedPaths(z.array(AgentRow), RECORDED_PROBES.listAgents).length === 0,
  getAgent:
    rejectedPaths(z.array(AgentDetail), RECORDED_PROBES.getAgent).length === 0,
  toolbelt:
    rejectedPaths(z.array(Toolbelt), RECORDED_PROBES.toolbelt).length === 0,
  incidents:
    rejectedPaths(z.array(Incident), RECORDED_PROBES.incidents).length === 0,
};

const AGENT_READ = PAGE_FAILURES.agent.permission;
/** Agents are workspace principals (spec §6.1); an organization page has none to list. */
const WORKSPACE_REQUIRED = readError("workspace_scope_required", 400);
const AGENT_NOT_FOUND = readError("agent_not_found", 404);
/** The mapped value broke its view model: never hand the page a shape it did not promise. */
const MISMATCH = readError("contract_output_mismatch", 502);
/** list_tacho_hosts and list_iam_roles page at 200. */
const PAGE = 200;

function serve<T>(viewModel: z.ZodType<T>, value: unknown): Read<T> {
  const parsed = viewModel.safeParse(value);
  return parsed.success ? readOk(parsed.data) : MISMATCH;
}

export function createLiveAgents(
  stores: AgentStores,
  ready: LiveReadiness = LIVE_READINESS,
): AgentReadPort {
  async function allHosts(scope: Scope): Promise<Read<HostSummary[]>> {
    const hosts: HostSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await stores.readTool(scope, tachoHostList, {
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok) return page;
      hosts.push(...page.value.hosts);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);
    return readOk(hosts);
  }

  async function allRoles(scope: Scope): Promise<Read<IamRoleRow[]>> {
    const roles: IamRoleRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await stores.readTool(scope, iamRoleList, {
        includeGrants: true,
        limit: PAGE,
        offset,
      });
      if (!page.ok) return page;
      roles.push(...page.value.roles);
      if (!page.value.hasMore) return readOk(roles);
    }
  }

  /** Every agent key in the workspace: its definition, its host, or both. */
  async function sources(scope: Scope): Promise<Read<AgentSource[]>> {
    const [defs, hosts, slug] = await Promise.all([
      stores.readTool(scope, agentDefinitionList, {}),
      allHosts(scope),
      stores.workspaceSlug(scope),
    ]);
    if (!defs.ok) return defs;
    if (!hosts.ok) return hosts;
    if (slug === null) return readError("workspace_not_found", 404);
    // A null key is a definition from before namespaces were backfilled: there
    // is nothing to link its page or its runs by.
    const keyed = defs.value.agents.flatMap((d) =>
      d.agentKey === null ? [] : [{ key: d.agentKey, definition: d }],
    );
    if (keyed.length < defs.value.agents.length)
      return readError("agent_key_unbackfilled", 503);

    const byKey = new Map<
      string,
      { definition: DefinitionRow | null; host: HostSummary | null }
    >();
    for (const { key, definition } of keyed)
      byKey.set(key, { definition, host: null });
    for (const h of hosts.value)
      byKey.set(h.agentKey, {
        definition: byKey.get(h.agentKey)?.definition ?? null,
        host: h,
      });

    const keys = [...byKey.keys()];
    const [principals, tiers, open] = await Promise.all([
      stores.principals(
        scope,
        defs.value.agents.map((d) => d.publicId),
      ),
      stores.latestTiers(scope, keys),
      stores.openIncidents(scope, keys),
    ]);
    return readOk(
      [...byKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, { definition, host }]) => ({
          key,
          workspaceSlug: slug,
          definition,
          host,
          principal: definition
            ? (principals.get(definition.publicId) ?? null)
            : null,
          latestTier: tiers.get(key) ?? null,
          // A count of recorded rows: zero means none are open, not unknown.
          openIncidents: open.get(key) ?? 0,
        })),
    );
  }

  async function source(scope: Scope, key: string): Promise<Read<AgentSource>> {
    const all = await sources(scope);
    if (!all.ok) return all;
    const found = all.value.find((s) => s.key === key);
    return found ? readOk(found) : AGENT_NOT_FOUND;
  }

  return {
    async listAgents(scope) {
      if (!ready.listAgents) return notBackedFor("agents", "listAgents");
      if (isOrgOnlyScope(scope)) return WORKSPACE_REQUIRED;
      const all = await sources(scope);
      if (!all.ok) return all;
      return serve(z.array(AgentRow), all.value.map(toAgentRow));
    },

    async getAgent(scope, key) {
      if (!ready.getAgent) return notBackedFor("agents", "getAgent");
      if (isOrgOnlyScope(scope)) return WORKSPACE_REQUIRED;
      const found = await source(scope, key);
      if (!found.ok) return found;
      const s = found.value;
      const [facts, assignments] = await Promise.all([
        s.host ? stores.hostFacts(scope, key) : null,
        // Roles are read through the definition's agent tool; an agent that is
        // only enrolled has none to read them by, so its roles stay unknown.
        s.definition
          ? stores.readTool(scope, agentRoleList, {
              agentId: s.definition.publicId,
            })
          : null,
      ]);
      if (assignments && !assignments.ok) return assignments;
      return serve(
        AgentDetail,
        toAgentDetail(s, facts, assignments?.value.roles ?? null),
      );
    },

    async toolbelt(scope, key) {
      if (!ready.toolbelt) return notBackedFor("agents", "toolbelt");
      if (isOrgOnlyScope(scope)) return WORKSPACE_REQUIRED;
      const found = await source(scope, key);
      if (!found.ok) return found;
      const def = found.value.definition;
      // An enrolled-only agent's belt is its host's policy bundle, not role grants.
      if (!def) return notBackedFor("agents", "toolbelt");
      const [assignments, roles]: [
        Read<AgentRoleListOutput>,
        Read<IamRoleRow[]>,
      ] = await Promise.all([
        stores.readTool(scope, agentRoleList, { agentId: def.publicId }),
        allRoles(scope),
      ]);
      if (!assignments.ok) return assignments;
      if (!roles.ok) return roles;
      // list_iam_roles returns no grant conditions, so every entry's scope is
      // unread (never null, which would claim no narrowing) and Toolbelt
      // refuses it: this stays not-backed until conditions can be shown.
      return serve(
        Toolbelt,
        toToolbelt(key, assignments.value.roles, roles.value, (tool) =>
          stores.describeTool(tool),
        ),
      );
    },

    async definition(scope, key) {
      if (isOrgOnlyScope(scope)) return WORKSPACE_REQUIRED;
      const defs = await stores.readTool(scope, agentDefinitionList, {});
      if (!defs.ok) return defs;
      const def = defs.value.agents.find((d) => d.agentKey === key);
      if (!def) return AGENT_NOT_FOUND;
      const got = await stores.readTool(scope, agentDefinitionGet, {
        agentId: def.publicId,
      });
      if (!got.ok) return got;
      return serve(AgentDefinition, toAgentDefinition(key, got.value));
    },

    // G11: trust and spend scores have no store and no spec table.
    scores: () => Promise.resolve(notBackedFor("agents", "scores")),

    async incidents(scope, key) {
      if (!ready.incidents) return notBackedFor("agents", "incidents");
      if (isOrgOnlyScope(scope)) return WORKSPACE_REQUIRED;
      // The incident stores have no agent tool: the agent's own IAM-checked
      // reads decide who may see them, and whether the key exists at all.
      const found = await source(scope, key);
      if (!found.ok) return found;
      const rows = await stores.incidents(scope, key);
      return serve(
        z.array(Incident),
        rows.map((row) => toIncident(key, row)),
      );
    },

    // G1: tools.mandates and tools.mandate_ledger do not exist yet.
    mandates: () => Promise.resolve(notBackedFor("agents", "mandates")),
    getMandate: () => Promise.resolve(notBackedFor("agents", "getMandate")),
  };
}

// ---- The real stores -------------------------------------------------------------

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

function inTenant<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTenantScope(scope, () => withTenantDb(fn));
}

/** A workspace-scoped table's rows in this tenant's workspace only. */
function inWorkspace(
  table: { orgId: PgColumn; workspaceId: PgColumn },
  scope: Scope,
): SQL | undefined {
  return and(
    eq(table.orgId, scope.orgId),
    eq(table.workspaceId, scope.workspaceId),
  );
}

/** Kernel codes that mean "this person may not read it", not "it failed". */
const DENIED_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
]);

let handlersRegistered: Promise<unknown> | null = null;

/**
 * Both handler registries: the agent tools this adapter reads are split
 * between @oxagen/handlers (list_tacho_hosts, list_iam_roles) and
 * @oxagen/agent (list_agent_defs, get_agent_def, list_agent_roles).
 */
function registerHandlers(): Promise<unknown> {
  handlersRegistered ??= Promise.all([
    import("@oxagen/handlers/register"),
    import("@oxagen/agent/register"),
  ]);
  return handlersRegistered;
}

export const liveAgentStores: AgentStores = {
  async readTool(scope, contract, input) {
    const session = await getSession();
    if (!session) return denied(AGENT_READ);
    await registerHandlers();
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId: session.user.id,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    };
    let raw: unknown;
    try {
      raw = await runInTenantScope(scope, () =>
        invoke(contract.name, input, ctx),
      );
    } catch (error) {
      if (error instanceof CapabilityError && DENIED_CODES.has(error.code))
        return denied(AGENT_READ);
      throw error;
    }
    const parsed = contract.output.safeParse(raw);
    return parsed.success ? readOk(parsed.data) : MISMATCH;
  },

  describeTool(name) {
    return getCapability(name)?.description ?? null;
  },

  async workspaceSlug(scope) {
    const rows = await inTenant(scope, (tx) =>
      tx
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, scope.orgId),
            eq(schema.workspaces.id, scope.workspaceId),
          ),
        )
        .limit(1),
    );
    return rows[0]?.slug ?? null;
  },

  async principals(scope, agentPublicIds) {
    const facts = new Map<string, PrincipalFacts>();
    if (agentPublicIds.length === 0) return facts;
    await inTenant(scope, async (tx) => {
      const agents = await tx
        .select({
          publicId: schema.agents.publicId,
          principalId: schema.agents.principalId,
        })
        .from(schema.agents)
        .where(
          and(
            inWorkspace(schema.agents, scope),
            inArray(schema.agents.publicId, [...agentPublicIds]),
          ),
        );
      const principalIds = agents.flatMap((a) =>
        a.principalId ? [a.principalId] : [],
      );
      if (principalIds.length === 0) return;
      const prns = await tx
        .select({
          id: schema.principals.id,
          publicId: schema.principals.publicId,
          status: schema.principals.status,
          parentUserId: schema.principals.parentUserId,
        })
        .from(schema.principals)
        .where(
          and(
            // An agent principal may be org-level: workspace_id is nullable.
            eq(schema.principals.orgId, scope.orgId),
            inArray(schema.principals.id, principalIds),
            eq(schema.principals.kind, "agent"),
          ),
        );
      const userIds = prns.flatMap((p) =>
        p.parentUserId ? [p.parentUserId] : [],
      );
      const users =
        userIds.length === 0
          ? []
          : await tx
              .select({ id: schema.users.id, publicId: schema.users.publicId })
              .from(schema.users)
              .where(inArray(schema.users.id, userIds));
      const userPublicId = new Map(users.map((u) => [u.id, u.publicId]));
      const byPrincipal = new Map(prns.map((p) => [p.id, p]));
      for (const a of agents) {
        const p = a.principalId ? byPrincipal.get(a.principalId) : undefined;
        if (!p) continue;
        facts.set(a.publicId, {
          publicId: p.publicId,
          status: p.status,
          operatorPublicId: p.parentUserId
            ? (userPublicId.get(p.parentUserId) ?? null)
            : null,
        });
      }
    });
    return facts;
  },

  async latestTiers(scope, keys) {
    const tiers = new Map<string, EnforcementTier>();
    if (keys.length === 0) return tiers;
    const rows = await inTenant(scope, (tx) =>
      tx
        .selectDistinctOn([schema.tachoSessions.agentKey], {
          agentKey: schema.tachoSessions.agentKey,
          tier: schema.tachoSessions.enforcementTier,
        })
        .from(schema.tachoSessions)
        .where(
          and(
            inWorkspace(schema.tachoSessions, scope),
            inArray(schema.tachoSessions.agentKey, [...keys]),
          ),
        )
        .orderBy(
          schema.tachoSessions.agentKey,
          desc(schema.tachoSessions.startedAt),
        ),
    );
    for (const row of rows) {
      const tier = EnforcementTier.safeParse(row.tier);
      if (tier.success) tiers.set(row.agentKey, tier.data);
    }
    return tiers;
  },

  async openIncidents(scope, keys) {
    const open = new Map<string, number>();
    if (keys.length === 0) return open;
    const t = schema.tachoIncidents;
    const hosts = schema.tachoHosts;
    const sessions = schema.tachoSessions;
    // UNION (not ALL) keeps one (key, incident) pair when an incident links
    // to both the agent's host and one of its runs.
    const links = await inTenant(scope, (tx) =>
      tx
        .select({ agentKey: hosts.agentKey, id: t.id })
        .from(t)
        .innerJoin(hosts, eq(t.hostId, hosts.id))
        .where(
          and(
            inWorkspace(t, scope),
            inWorkspace(hosts, scope),
            isNull(t.resolvedAt),
            inArray(hosts.agentKey, [...keys]),
          ),
        )
        .union(
          tx
            .select({ agentKey: sessions.agentKey, id: t.id })
            .from(t)
            .innerJoin(sessions, eq(t.sessionId, sessions.id))
            .where(
              and(
                inWorkspace(t, scope),
                inWorkspace(sessions, scope),
                isNull(t.resolvedAt),
                inArray(sessions.agentKey, [...keys]),
              ),
            ),
        ),
    );
    for (const { agentKey } of links)
      open.set(agentKey, (open.get(agentKey) ?? 0) + 1);
    return open;
  },

  async hostFacts(scope, key) {
    return inTenant(scope, async (tx) => {
      const [host] = await tx
        .select({
          deviceKeyFingerprint: schema.tachoHosts.deviceKeyFingerprint,
          apiKeyId: schema.tachoHosts.apiKeyId,
        })
        .from(schema.tachoHosts)
        .where(
          and(
            inWorkspace(schema.tachoHosts, scope),
            eq(schema.tachoHosts.agentKey, key),
          ),
        )
        .limit(1);
      if (!host) return null;
      const [apiKey] = await tx
        .select({
          keyPrefix: schema.apiKeys.keyPrefix,
          createdAt: schema.apiKeys.createdAt,
          lastUsedAt: schema.apiKeys.lastUsedAt,
        })
        .from(schema.apiKeys)
        .where(
          and(
            inWorkspace(schema.apiKeys, scope),
            eq(schema.apiKeys.id, host.apiKeyId),
          ),
        )
        .limit(1);
      const [first] = await tx
        .select({ at: min(schema.tachoSessions.startedAt) })
        .from(schema.tachoSessions)
        .where(
          and(
            inWorkspace(schema.tachoSessions, scope),
            eq(schema.tachoSessions.agentKey, key),
          ),
        );
      return {
        deviceKeyFingerprint: host.deviceKeyFingerprint,
        apiKey: apiKey ?? null,
        firstSessionAt: first?.at ?? null,
      };
    });
  },

  async incidents(scope, key) {
    return inTenant(scope, async (tx) => {
      const t = schema.tachoIncidents;
      const rows = await tx
        .select({
          publicId: t.publicId,
          kind: t.kind,
          severity: t.severity,
          detectedAt: t.detectedAt,
          detectedBy: t.detectedBy,
          resolvedAt: t.resolvedAt,
          resolutionNote: t.resolutionNote,
          hostId: t.hostId,
          sessionId: t.sessionId,
          resolvedBy: t.resolvedByPrincipalId,
        })
        .from(t)
        .where(
          and(
            inWorkspace(t, scope),
            or(
              inArray(
                t.hostId,
                tx
                  .select({ id: schema.tachoHosts.id })
                  .from(schema.tachoHosts)
                  .where(
                    and(
                      inWorkspace(schema.tachoHosts, scope),
                      eq(schema.tachoHosts.agentKey, key),
                    ),
                  ),
              ),
              inArray(
                t.sessionId,
                tx
                  .select({ id: schema.tachoSessions.id })
                  .from(schema.tachoSessions)
                  .where(
                    and(
                      inWorkspace(schema.tachoSessions, scope),
                      eq(schema.tachoSessions.agentKey, key),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(desc(t.detectedAt));
      if (rows.length === 0) return [];

      const ids = (pick: (r: (typeof rows)[number]) => string | null) => [
        ...new Set(
          rows.flatMap((r) => {
            const id = pick(r);
            return id ? [id] : [];
          }),
        ),
      ];
      const hostIds = ids((r) => r.hostId);
      const sessionIds = ids((r) => r.sessionId);
      const resolverIds = ids((r) => r.resolvedBy);
      const hosts =
        hostIds.length === 0
          ? []
          : await tx
              .select({
                id: schema.tachoHosts.id,
                hostname: schema.tachoHosts.hostname,
              })
              .from(schema.tachoHosts)
              .where(
                and(
                  inWorkspace(schema.tachoHosts, scope),
                  inArray(schema.tachoHosts.id, hostIds),
                ),
              );
      const sessions =
        sessionIds.length === 0
          ? []
          : await tx
              .select({
                id: schema.tachoSessions.id,
                publicId: schema.tachoSessions.publicId,
              })
              .from(schema.tachoSessions)
              .where(
                and(
                  inWorkspace(schema.tachoSessions, scope),
                  inArray(schema.tachoSessions.id, sessionIds),
                ),
              );
      const resolvers =
        resolverIds.length === 0
          ? []
          : await tx
              .select({
                id: schema.principals.id,
                publicId: schema.principals.publicId,
              })
              .from(schema.principals)
              .where(
                and(
                  eq(schema.principals.orgId, scope.orgId),
                  inArray(schema.principals.id, resolverIds),
                ),
              );
      const hostname = new Map(hosts.map((h) => [h.id, h.hostname]));
      const sessionPublicId = new Map(sessions.map((s) => [s.id, s.publicId]));
      const resolverPublicId = new Map(
        resolvers.map((p) => [p.id, p.publicId]),
      );
      return rows.map(
        (r): IncidentRow => ({
          publicId: r.publicId,
          kind: r.kind,
          severity: r.severity,
          detectedAt: r.detectedAt,
          detectedBy: r.detectedBy,
          resolvedAt: r.resolvedAt,
          resolutionNote: r.resolutionNote,
          hostname: r.hostId ? (hostname.get(r.hostId) ?? null) : null,
          sessionPublicId: r.sessionId
            ? (sessionPublicId.get(r.sessionId) ?? null)
            : null,
          resolvedByPublicId: r.resolvedBy
            ? (resolverPublicId.get(r.resolvedBy) ?? null)
            : null,
        }),
      );
    });
  },
};

export const liveAgents: AgentReadPort = createLiveAgents(liveAgentStores);
