import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  AgentDefinitionListInput,
  AgentDefinitionListOutput,
} from "@oxagen/oxagen/contracts/agent.definition.list";
import { agentToolTypeSchema } from "@oxagen/oxagen/agent-schema";
import type { AgentToolType } from "@oxagen/oxagen/agent-schema";
import type { CapabilityContext } from "../types";
import {
  isManagedAgentType,
  resolveNamespacePrefix,
  composeAgentKey,
} from "./_agent-definition";

export type { AgentDefinitionListInput, AgentDefinitionListOutput };

type AgentToolRef = { type: AgentToolType; ref: string };

/**
 * Pull the refs-only view of an agent's loaded tools from its persisted version
 * `config` (JSONB). Defensive by design: the list must never fail because one
 * agent's config is malformed, so anything that isn't a well-formed agentTool
 * entry (known `type`, non-empty string `ref`) is silently skipped rather than
 * thrown — unlike parseAgentDefinitionConfig, which is strict. Config payloads
 * (MCP auth, skill pins, budgets) are intentionally dropped; this is refs-only.
 */
function extractAgentToolRefs(config: unknown): AgentToolRef[] {
  if (!config || typeof config !== "object") return [];
  const tools = (config as { agentTools?: unknown }).agentTools;
  if (!Array.isArray(tools)) return [];
  const refs: AgentToolRef[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const ref = (tool as { ref?: unknown }).ref;
    if (typeof ref !== "string" || ref.length === 0) continue;
    const type = agentToolTypeSchema.safeParse(
      (tool as { type?: unknown }).type,
    );
    if (!type.success) continue;
    refs.push({ type: type.data, ref });
  }
  return refs;
}

/**
 * List the workspace's (non-deleted) agents with their identity, lifecycle
 * status, deployment posture, and the highest version number on file.
 */
export async function agentDefinitionListHandler(
  input: AgentDefinitionListInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionListOutput> {
  const { rows, orgNamespace, workspaceNamespace } = await withTenantDb(
    async (tx) => {
      const rows = await tx
        .select({
          id: schema.agents.id,
          publicId: schema.agents.publicId,
          slug: schema.agents.slug,
          name: schema.agents.name,
          description: schema.agents.description,
          avatarUrl: schema.agents.avatarUrl,
          summary: schema.agents.summary,
          agentType: schema.agents.agentType,
          status: schema.agents.status,
          deploymentStatus: schema.agents.deploymentStatus,
          latestVersion: sql<
            number | null
          >`max(${schema.agentVersions.version})`,
          // Config of the version the agent would actually run — its active
          // (published) version, else its latest version — matching
          // agent.definition.get's resolution. A correlated scalar subquery keeps
          // this a single round-trip (no N+1). Inner table aliased `av2` so its
          // columns never collide with the outer join above. Only agents.id (the
          // grouped PK) and agents.active_version_id (functionally dependent on it)
          // are referenced, so it is valid alongside the GROUP BY.
          selectedConfig: sql<unknown>`(
          select av2.config
          from ${schema.agentVersions} as av2
          where av2.agent_id = ${schema.agents.id}
          order by (av2.id = ${schema.agents.activeVersionId}) desc, av2.version desc
          limit 1
        )`,
        })
        .from(schema.agents)
        .leftJoin(
          schema.agentVersions,
          eq(schema.agentVersions.agentId, schema.agents.id),
        )
        .where(
          and(
            eq(schema.agents.workspaceId, ctx.workspaceId),
            isNull(schema.agents.deletedAt),
            input.status ? eq(schema.agents.status, input.status) : undefined,
          ),
        )
        .groupBy(
          schema.agents.id,
          schema.agents.publicId,
          schema.agents.slug,
          schema.agents.name,
          schema.agents.description,
          schema.agents.avatarUrl,
          schema.agents.summary,
          schema.agents.agentType,
          schema.agents.status,
          schema.agents.deploymentStatus,
        );

      // Resolve both immutable namespaces ONCE for the whole list (never per row).
      const { orgNamespace, workspaceNamespace } = await resolveNamespacePrefix(
        tx,
        ctx.orgId,
        ctx.workspaceId,
      );
      return { rows, orgNamespace, workspaceNamespace };
    },
  );

  return {
    agents: rows.map((r) => ({
      agentId: r.publicId,
      publicId: r.publicId,
      slug: r.slug,
      agentKey: composeAgentKey(orgNamespace, workspaceNamespace, r.slug),
      name: r.name,
      description: r.description,
      avatarUrl: r.avatarUrl,
      summary: r.summary,
      agentType: r.agentType,
      status: r.status as "draft" | "active" | "archived",
      deploymentStatus: r.deploymentStatus as "inactive" | "active",
      latestVersion: r.latestVersion ?? null,
      managed: isManagedAgentType(r.agentType),
      toolRefs: extractAgentToolRefs(r.selectedConfig),
    })),
  };
}
