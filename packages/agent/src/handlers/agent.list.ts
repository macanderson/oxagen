// list_agents — the identities table, one page by slug, with the counts and
// 30-day figures the stores record. Row semantics and every null's reason
// are on the contract (packages/oxagen/src/contracts/agent.list.ts).
import { withTenantDb } from "@oxagen/database";
import {
  type AgentListInput,
  type AgentListItem,
  type AgentListOutput,
  agentEnforcementTierSchema,
} from "@oxagen/oxagen/contracts/agent.list";
import { microsString } from "@oxagen/oxagen/contracts/spend.shared";
import { isManagedAgentType } from "@oxagen/oxagen/interactive-agent";
import type { CapabilityContext } from "../types";
import {
  activeCredentialsByAgent,
  activeMandatesByPrincipal,
  agentKeysFor,
  bindingRefs,
  identityStatus,
  runtimeRef,
  toolbeltRef,
  latestLiveHostByAgentKey,
  listAgentIdentities,
  liveHostsByAgentKey,
  newestTamperIncident,
  openIncidentsByAgentKey,
  runFiguresByAgent,
  tamperIncidentsByAgentKey,
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
    /** Tamper incidents on the agent's hosts the store keeps, open or resolved. */
    tamperIncidentsRecorded?: number;
    /** Active mandates held by the principal; null when the row has no principal. */
    mandates: number | null;
    host: string | null;
    figures: RunWindowFigures | undefined;
    /** The agent's runtime (ADR-192); null when it runs on no named runtime. */
    runtime?: AgentListItem["runtime"];
    /** The agent's toolbelt, the All tools belt when the row names none. */
    toolbelt?: AgentListItem["toolbelt"];
  },
): AgentListItem {
  return {
    id: row.publicId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    agentKey: facts.agentKey,
    harness: row.harness as AgentListItem["harness"],
    runtime: facts.runtime ?? null,
    toolbelt: facts.toolbelt ?? null,
    managed: isManagedAgentType(row.agentType),
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
    tokens30d: facts.figures?.tokens ?? null,
    proven30d: null,
    mandates: facts.mandates,
    incidents: facts.incidents,
    tamperIncidents: facts.tamperIncidents,
    tamperIncidentsRecorded:
      facts.tamperIncidentsRecorded ?? facts.tamperIncidents,
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
      includeRetired: input.includeRetired,
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
    const tamper = await tamperIncidentsByAgentKey(tx, scope, agentKeys);
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
    const bindings = await bindingRefs(tx, scope, {
      runtimeIds: page.map((r) => r.runtimeId),
      toolbeltIds: page.map((r) => r.toolbeltId),
    });

    // The tiles cover the whole workspace, so they are counted apart from
    // the page: every live agent, how many hold a credential or a host, and
    // the tamper incidents on the hosts enrolled under their agent keys. The
    // tamper figures are sums over the same per-agent set the rows read, so
    // the tile is the rollup of the Incidents column, never a second count.
    // A retired agent is a deleted record, so the tiles leave it out whether
    // or not the page shows it. It is only counted, so the page can offer it.
    const everyone = await listAgentIdentities(tx, scope, {
      limit: 10_000,
      afterSlug: undefined,
      includeRetired: true,
    });
    const all = everyone.filter((r) => r.status !== "archived");
    const retired = everyone.length - all.length;
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
    const allTamper = await tamperIncidentsByAgentKey(tx, scope, allAgentKeys);
    let tamperRecorded = 0;
    let tamperOpen = 0;
    for (const counts of allTamper.values()) {
      tamperRecorded += counts.recorded;
      tamperOpen += counts.open;
    }
    const newest = await newestTamperIncident(tx, scope, allAgentKeys);

    const allMandates = await activeMandatesByPrincipal(
      tx,
      scope,
      all.flatMap((r) => (r.principalId === null ? [] : [r.principalId])),
    );
    // The holders' keys come from the same filter as the count, so the tile
    // names exactly the agents it counts. `all` is in slug order.
    const holders = all.filter(
      (r) =>
        r.principalId !== null && (allMandates.get(r.principalId) ?? 0) > 0,
    );
    const holdingMandate = holders.length;
    const mandateHolders = holders
      .slice(0, 100)
      .map((r) => allKeys.get(r.id) ?? r.slug);

    // Each live agent's status, derived once. A suspended agent is neither
    // enrolled nor waiting to enroll, so both tiles count by status.
    const statuses = all.map((r) =>
      identityStatus(r, {
        credentials: allCredentials.get(r.publicId) ?? 0,
        hosts: (() => {
          const k = allKeys.get(r.id);
          return k ? (allHosts.get(k) ?? 0) : 0;
        })(),
      }),
    );
    const enrolled = statuses.filter((s) => s === "enrolled").length;
    const unenrolled = statuses.filter((s) => s === "unenrolled").length;

    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const agentKey = keys.get(row.id) ?? null;
        return toAgentListItem(row, {
          agentKey,
          credentials: credentials.get(row.publicId) ?? 0,
          hosts: agentKey ? (hosts.get(agentKey) ?? 0) : 0,
          incidents: agentKey ? (incidents.get(agentKey) ?? 0) : 0,
          tamperIncidents: agentKey ? (tamper.get(agentKey)?.open ?? 0) : 0,
          tamperIncidentsRecorded: agentKey
            ? (tamper.get(agentKey)?.recorded ?? 0)
            : 0,
          mandates:
            row.principalId === null
              ? null
              : (mandates.get(row.principalId) ?? 0),
          host: agentKey ? (liveHost.get(agentKey) ?? null) : null,
          figures: figures.get(row.id),
          runtime:
            row.runtimeId === null
              ? null
              : runtimeRef(bindings.runtimes.get(row.runtimeId)),
          toolbelt: toolbeltRef(
            row.toolbeltId === null
              ? bindings.allTools
              : bindings.toolbelts.get(row.toolbeltId),
          ),
        });
      }),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor(last.slug) : null,
      totals: {
        identities: all.length,
        retired,
        enrolled,
        unenrolled,
        holdingMandate,
        mandateHolders,
        tamperIncidents: tamperOpen,
        tamper: {
          recorded: tamperRecorded,
          open: tamperOpen,
          newest:
            newest === null
              ? null
              : {
                  agentKey: newest.agentKey,
                  kind: newest.kind,
                  detectedAt: newest.detectedAt.toISOString(),
                },
        },
      },
    };
  });
}
