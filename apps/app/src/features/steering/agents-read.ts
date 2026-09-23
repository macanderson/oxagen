// The agents Steering assembles for (roadmap pages/steering-assignments.md and
// steering-compiler.md): the workspace's enrolled agents, read from the agent
// registry. Steering reaches an agent through a hook on its runtime, and an
// agent is enrolled when it holds a live credential or host, so an enrolled
// agent is the one set up for steering. `list_agents` pages by cursor; this
// follows it up to `AGENT_READ_PAGES` pages and says when it stopped short.
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

/** The most `list_agents` pages one Steering view reads. */
export const AGENT_READ_PAGES = 10;

export type SteeringAgent = AgentPage["agents"][number];

export type SteeringAgents = {
  /** The enrolled agents read, in the registry's order. */
  agents: SteeringAgent[];
  /** Enrolled agents in the whole workspace, from the registry's totals. */
  enrolled: number;
  /** True when a later page was left unread. */
  truncated: boolean;
};

export async function readSteeringAgents(
  ctx: WsCtx,
  source: DataSource,
): Promise<Read<SteeringAgents>> {
  const agents: SteeringAgent[] = [];
  let cursor: string | null = null;
  let enrolled = 0;
  for (let page = 0; page < AGENT_READ_PAGES; page++) {
    const read = await source.agents.list(ctx, { cursor });
    // One failed page fails the list: a table that silently drops a page
    // would print a count the registry does not hold.
    if (!read.ok) return read;
    if (page === 0) enrolled = read.value.totals.enrolled;
    agents.push(...read.value.agents.filter((a) => a.status === "enrolled"));
    cursor = read.value.nextCursor;
    if (cursor === null) break;
  }
  return readOk({ agents, enrolled, truncated: cursor !== null });
}
