// audit-exempt: read-only — lists runtimes and the agents on them; the kernel capability.invoke_* audit covers access.
//
// runtime.list.ts — the runtimes named in this workspace, each with its live
// agents and their harness, its live host enrollments and when a host last
// reported (ADR-198, #4369). The register form reads the agents to disable a
// runtime and harness pair a live agent already holds.
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import type { AgentHarness } from "@oxagen/oxagen/contracts/agent.list";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

/** The most runtimes one read returns (`runtimeList.output.items`). */
const RUNTIMES_READ_LIMIT = 500;
/** The most agents a runtime lists (`runtimeListItem.agents`). */
const AGENTS_PER_RUNTIME = 16;

export const runtimeListHandler: CapabilityHandler<typeof runtimeList> = async (
  _input,
  ctx,
) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  return withTenantDb(async (tx) => {
    const runtimes = await tx
      .select({
        id: schema.runtimes.id,
        publicId: schema.runtimes.publicId,
        name: schema.runtimes.name,
        slug: schema.runtimes.slug,
        createdAt: schema.runtimes.createdAt,
      })
      .from(schema.runtimes)
      .where(
        and(
          eq(schema.runtimes.orgId, scope.orgId),
          eq(schema.runtimes.workspaceId, scope.workspaceId),
          isNull(schema.runtimes.deletedAt),
        ),
      )
      .orderBy(asc(schema.runtimes.name))
      .limit(RUNTIMES_READ_LIMIT);
    const ids = runtimes.map((r) => r.id);
    if (ids.length === 0) return { items: [] };

    const agents = await tx
      .select({
        runtimeId: schema.agents.runtimeId,
        publicId: schema.agents.publicId,
        name: schema.agents.name,
        slug: schema.agents.slug,
        harness: schema.agents.harness,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, scope.orgId),
          eq(schema.agents.workspaceId, scope.workspaceId),
          inArray(schema.agents.runtimeId, ids),
          isNull(schema.agents.deletedAt),
          ne(schema.agents.status, "archived"),
        ),
      )
      .orderBy(asc(schema.agents.harness));
    const agentsByRuntime = new Map<string, typeof agents>();
    for (const agent of agents) {
      if (agent.runtimeId === null) continue;
      const list = agentsByRuntime.get(agent.runtimeId) ?? [];
      list.push(agent);
      agentsByRuntime.set(agent.runtimeId, list);
    }

    const hosts = await tx
      .select({
        runtimeId: schema.tachoHosts.runtimeId,
        live: sql<number>`count(*) filter (where ${schema.tachoHosts.status} <> 'revoked')::int`,
        lastSeenAt: sql<Date | null>`max(${schema.tachoHosts.lastSeenAt})`,
      })
      .from(schema.tachoHosts)
      .where(
        and(
          eq(schema.tachoHosts.orgId, scope.orgId),
          eq(schema.tachoHosts.workspaceId, scope.workspaceId),
          inArray(schema.tachoHosts.runtimeId, ids),
        ),
      )
      .groupBy(schema.tachoHosts.runtimeId);
    const hostsByRuntime = new Map(hosts.map((h) => [h.runtimeId, h]));

    return {
      items: runtimes.map((runtime) => {
        const held = hostsByRuntime.get(runtime.id);
        const lastSeen = held?.lastSeenAt ?? null;
        return {
          id: runtime.publicId,
          name: runtime.name,
          slug: runtime.slug,
          createdAt: runtime.createdAt.toISOString(),
          agents: (agentsByRuntime.get(runtime.id) ?? [])
            .slice(0, AGENTS_PER_RUNTIME)
            .map((a) => ({
              id: a.publicId,
              name: a.name,
              slug: a.slug,
              harness: a.harness as AgentHarness,
            })),
          liveHosts: held?.live ?? 0,
          // An aggregate over a timestamp comes back as a string on some
          // drivers, so it is read through Date either way.
          lastSeenAt:
            lastSeen === null ? null : new Date(lastSeen).toISOString(),
        };
      }),
    };
  });
};
