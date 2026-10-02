// Each agent's registered harness, for a surface whose record names an agent
// but not its harness: a Spend row by agent, an approval, a question an agent
// asked, a mandate, a toolbelt's agents. The surface badges the agent's avatar
// with the harness it registered, as the run header does for a run that
// recorded none (#4871).
//
// The index walks `list_agents` with retired agents included. Retirement keeps
// an agent's runs, receipts and mandates, so their badges still name its
// harness. A record that carries the agent key looks it up by key, and one
// that carries the slug alone (a mandate, a toolbelt's agents) by slug, since
// the key's namespaces cannot be built from the workspace's slug.
//
// A failed first page leaves the index empty and every surface unbadged; a
// failed later page keeps what the earlier pages returned. The kernel seam
// serves one read per request, so a page that already listed the agents pays
// nothing for the walk.
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";

/** The pages the walk reads: 20 of 50, the bound Fleet's roster walk uses. */
const AGENT_PAGES_MAX = 20;

export type AgentHarnessIndex = {
  /** By agent key (`org_ns.ws_ns.slug`). */
  readonly byKey: Readonly<Record<string, string>>;
  /** By the agent's slug in this workspace. */
  readonly bySlug: Readonly<Record<string, string>>;
};

export const EMPTY_HARNESS_INDEX: AgentHarnessIndex = { byKey: {}, bySlug: {} };

export async function readAgentHarnessIndex(
  ctx: WsCtx,
  source: DataSource,
): Promise<AgentHarnessIndex> {
  const byKey: Record<string, string> = {};
  const bySlug: Record<string, string> = {};
  let cursor: string | null = null;
  for (let page = 0; page < AGENT_PAGES_MAX; page += 1) {
    const read = await source.agents.list(ctx, {
      cursor,
      includeRetired: true,
    });
    if (!read.ok) break;
    for (const agent of read.value.agents) {
      bySlug[agent.slug] = agent.harness;
      if (agent.agentKey !== null) byKey[agent.agentKey] = agent.harness;
    }
    cursor = read.value.nextCursor;
    if (cursor === null) break;
  }
  return { byKey, bySlug };
}

/** The harness an agent key names in the index, or null for one it does not hold. */
export function harnessOfKey(
  index: AgentHarnessIndex,
  agentKey: string | null | undefined,
): string | null {
  if (agentKey === null || agentKey === undefined) return null;
  return Object.hasOwn(index.byKey, agentKey)
    ? (index.byKey[agentKey] ?? null)
    : null;
}

/** The harness an agent slug names in the index, or null for one it does not hold. */
export function harnessOfSlug(
  index: AgentHarnessIndex,
  slug: string | null | undefined,
): string | null {
  if (slug === null || slug === undefined) return null;
  return Object.hasOwn(index.bySlug, slug)
    ? (index.bySlug[slug] ?? null)
    : null;
}
