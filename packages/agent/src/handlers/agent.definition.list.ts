import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  AgentDefinitionListInput,
  AgentDefinitionListOutput,
} from "@oxagen/oxagen/contracts/agent.definition.list";
import type { CapabilityContext } from "../types";
import {
  isManagedAgentType,
  resolveNamespacePrefix,
  composeAgentKey,
} from "./_agent-definition";

export type { AgentDefinitionListInput, AgentDefinitionListOutput };

/**
 * List the workspace's (non-deleted) agents with their identity, lifecycle
 * status, deployment posture, and the highest version number on file.
 */
export async function agentDefinitionListHandler(
  input: AgentDefinitionListInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionListOutput> {
  const { rows, orgNamespace, workspaceNamespace } = await withTenantDb(async (tx) => {
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
        latestVersion: sql<number | null>`max(${schema.agentVersions.version})`,
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
  });

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
    })),
  };
}
