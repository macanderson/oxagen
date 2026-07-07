import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { agentDefinitionConfigSchema } from "@oxagen/oxagen/agent-schema";
import type {
  AgentDefinitionUpdateInput,
  AgentDefinitionUpdateOutput,
} from "@oxagen/oxagen/contracts/agent.definition.update";
import type { CapabilityContext } from "../types";
import {
  resolveAgent,
  assertAgentMutable,
  isManagedAgentType,
} from "./_agent-definition";

export type { AgentDefinitionUpdateInput, AgentDefinitionUpdateOutput };

/**
 * Update a definition by snapshotting a NEW unpublished version. Published
 * versions are immutable — we never edit one in place. The version number is
 * the current max + 1. Optionally updates the agent's mutable identity fields
 * (name/description).
 */
export async function agentDefinitionUpdateHandler(
  input: AgentDefinitionUpdateInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionUpdateOutput> {
  const config = agentDefinitionConfigSchema.parse(input.config);

  if (!ctx.userId) {
    throw new Error("agent.definition.update requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }
    assertAgentMutable(agent);

    // A caller may not promote a user agent into a managed/built-in type — that
    // reserved space is owned by the platform, not the Studio editor. Guard
    // before any write so no version snapshot is wasted.
    if (input.agentType !== undefined && isManagedAgentType(input.agentType)) {
      throw new Error(
        `agentType "${input.agentType}" is reserved for managed agents`,
      );
    }

    const [latest] = await tx
      .select({ version: schema.agentVersions.version })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agent.id))
      .orderBy(desc(schema.agentVersions.version))
      .limit(1);

    const nextVersion = (latest?.version ?? 0) + 1;

    const [inserted] = await tx
      .insert(schema.agentVersions)
      .values({
        agentId: agent.id,
        version: nextVersion,
        isPublished: false,
        checksum: null,
        config,
        createdByUserId: userId,
      })
      .returning({
        version: schema.agentVersions.version,
        isPublished: schema.agentVersions.isPublished,
      });
    if (!inserted) throw new Error("agent_versions insert failed");

    if (
      input.name !== undefined ||
      input.description !== undefined ||
      input.agentType !== undefined
    ) {
      await tx
        .update(schema.agents)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.agentType !== undefined
            ? { agentType: input.agentType }
            : {}),
          updatedByUserId: userId,
        })
        .where(
          and(
            eq(schema.agents.id, agent.id),
            eq(schema.agents.workspaceId, ctx.workspaceId),
          ),
        );
    }

    return {
      agentId: agent.publicId,
      version: inserted.version,
      isPublished: inserted.isPublished,
    };
  });
}
