// list_agents — the identities table, one page by slug, with the counts and
// 30-day figures the stores record. Row semantics and every null's reason
// are on the contract (packages/oxagen/src/contracts/agent.list.ts).
import { schema, withTenantDb } from "@oxagen/database";
import {
  type AgentListInput,
  type AgentListItem,
  type AgentListOutput,
  agentEnforcementTierSchema,
} from "@oxagen/oxagen/contracts/agent.list";
import { TAMPER_INCIDENT_KINDS } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { microsString } from "@oxagen/oxagen/contracts/spend.shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import {
  activeCredentialsByAgent,
  activeMandatesByPrincipal,
  agentKeysFor,
  identityStatus,
  latestLiveHostByAgentKey,
  listAgentIdentities,
  liveHostsByAgentKey,
  openIncidentsByAgentKey,
  runFiguresByAgent,
  type AgentIdentityRow,
  type RunWindowFigures,
} from "./_agent-identity";

export type { AgentListInput, AgentListOutput };

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** The wrapped session store prices in micro-USD (`tacho.sessions.total_cost_micros`). */
const USD = "USD";

/** The page boundary is the last row's slug: unique per workspace, so a total order. */
export function encodeCursor(slug: string): string {
  return Buffer.from(slug, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const slug = Buffer.from(cursor, "base64url").toString("utf8");
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? slug : undefined;
}

export function toAgentListItem(
  row: AgentIdentityRow,
  facts: {
    agentKey: string | null;
    credentials: number;
    hosts: number;
    incidents: number;
    tamperIncidents: number;
    /** Active mandates held by the principal; null when the row has no principal. */
    mandates: number | null;
    host: string | null;
    figures: RunWindowFigures | undefined;
  },
): AgentListItem {
  return {
    id: row.publicId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    agentKey: facts.agentKey,
    harness: row.harness as AgentListItem["harness"],
    principalId: row.principalPublicId,
    operatorId: row.operatorPublicId,
    operatorName: row.operatorPublicId === null ? null : row.operatorName,
    status: identityStatus(row, facts),
    tier: null,
    enforcementTier: enforcementTierOf(facts.figures?.latestTier ?? null),
    beltSize: null,
    runs30d: facts.figures?.runs ?? 0,
    spend30d:
      facts.figures && facts.figures.spendMicros !== null
        ? {
            micros: microsString(facts.figures.spendMicros),
            currency: USD,
            basis: "client_attested",
          }
        : null,
    proven30d: null,
    mandates: facts.mandates,
    incidents: facts.incidents,
    tamperIncidents: facts.tamperIncidents,
    credentials: facts.credentials,
    hosts: facts.hosts,
    host: facts.host,
    registeredAt: row.createdAt.toISOString(),
  };
}

/**
 * A recorded tier read back onto the ladder. A value the ladder does not name
 * is reported as no tier rather than widened into one: a trust word is shown
 * only where it was recorded.
 */
function enforcementTierOf(
  recorded: string | null,
): AgentListItem["enforcementTier"] {
  const parsed = agentEnforcementTierSchema.safeParse(recorded);
  return parsed.success ? parsed.data : null;
}

export async function agentListHandler(
  input: AgentListInput,
  ctx: CapabilityContext,
): Promise<AgentListOutput> {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const windowStart = new Date(Date.now() - THIRTY_DAYS_MS);
  return withTenantDb(async (tx) => {
    const rows = await listAgentIdentities(tx, scope, {
      limit: input.limit + 1,
      afterSlug: decodeCursor(input.cursor),
    });
    const page = rows.slice(0, input.limit);
    const keys = await agentKeysFor(tx, scope, page);
    const agentKeys = [...keys.values()].filter((k): k is string => k !== null);
    const credentials = await activeCredentialsByAgent(
      tx,
      scope,
      page.map((r) => r.publicId),
    );
    const hosts = await liveHostsByAgentKey(tx, scope, agentKeys);
    const incidents = await openIncidentsByAgentKey(tx, scope, agentKeys);
    const tamper = await openIncidentsByAgentKey(tx, scope, agentKeys, true);
    const liveHost = await latestLiveHostByAgentKey(tx, scope, agentKeys);
    const mandates = await activeMandatesByPrincipal(
      tx,
      scope,
      page.flatMap((r) => (r.principalId === null ? [] : [r.principalId])),
    );
    const figures = await runFiguresByAgent(
      tx,
      scope,
      page.map((r) => ({ id: r.id, agentKey: keys.get(r.id) ?? null })),
      windowStart,
    );

    // The tiles cover the whole workspace, so they are counted apart from
    // the page: every live agent, how many hold a credential or a host, and
    // the open tamper incidents on every host in the workspace.
    const all = await listAgentIdentities(tx, scope, {
      limit: 10_000,
      afterSlug: undefined,
    });
    const allKeys = await agentKeysFor(tx, scope, all);
    const allAgentKeys = [...allKeys.values()].filter(
      (k): k is string => k !== null,
    );
    const allCredentials = await activeCredentialsByAgent(
      tx,
      scope,
      all.map((r) => r.publicId),
    );
    const allHosts = await liveHostsByAgentKey(tx, scope, allAgentKeys);
    const [tamperTotal] = await tx
      .select({ tamperIncidents: sql<number>`count(*)::int` })
      .from(schema.tachoIncidents)
      .where(
        and(
          eq(schema.tachoIncidents.orgId, scope.orgId),
          eq(schema.tachoIncidents.workspaceId, scope.workspaceId),
          isNull(schema.tachoIncidents.resolvedAt),
          sql`${schema.tachoIncidents.kind} in (${sql.join(
            TAMPER_INCIDENT_KINDS.map((k) => sql`${k}`),
            sql`, `,
          )})`,
        ),
      );

    const allMandates = await activeMandatesByPrincipal(
      tx,
      scope,
      all.flatMap((r) => (r.principalId === null ? [] : [r.principalId])),
    );
    const holdingMandate = all.filter(
      (r) => r.principalId !== null && (allMandates.get(r.principalId) ?? 0) > 0,
    ).length;

    const enrolled = all.filter(
      (r) =>
        identityStatus(r, {
          credentials: allCredentials.get(r.publicId) ?? 0,
          hosts: (() => {
            const k = allKeys.get(r.id);
            return k ? (allHosts.get(k) ?? 0) : 0;
          })(),
        }) === "enrolled",
    ).length;

    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const agentKey = keys.get(row.id) ?? null;
        return toAgentListItem(row, {
          agentKey,
          credentials: credentials.get(row.publicId) ?? 0,
          hosts: agentKey ? (hosts.get(agentKey) ?? 0) : 0,
          incidents: agentKey ? (incidents.get(agentKey) ?? 0) : 0,
          tamperIncidents: agentKey ? (tamper.get(agentKey) ?? 0) : 0,
          mandates:
            row.principalId === null
              ? null
              : (mandates.get(row.principalId) ?? 0),
          host: agentKey ? (liveHost.get(agentKey) ?? null) : null,
          figures: figures.get(row.id),
        });
      }),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor(last.slug) : null,
      totals: {
        identities: all.length,
        enrolled,
        holdingMandate,
        tamperIncidents: tamperTotal?.tamperIncidents ?? 0,
      },
    };
  });
}
