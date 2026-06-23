import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { computeConfigChecksum } from "@oxagen/oxagen/interactive-agent";
import type {
  AgentDefinitionPublishInput,
  AgentDefinitionPublishOutput,
} from "@oxagen/oxagen/contracts/agent.definition.publish";
import type { CapabilityContext } from "../types";
import { resolveAgent, assertAgentMutable } from "./_agent-definition";

export type { AgentDefinitionPublishInput, AgentDefinitionPublishOutput };

/**
 * Publish a version: mark it isPublished, stamp a deterministic checksum over
 * its config, and point the agent's activeVersionId at it. Publishing the same
 * version twice is rejected — a published version is immutable.
 */
export async function agentDefinitionPublishHandler(
  input: AgentDefinitionPublishInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionPublishOutput> {
  if (!ctx.userId) {
    throw new Error("agent.definition.publish requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }
    assertAgentMutable(agent);

    // Resolve target version: explicit number, else latest.
    const targetVersion =
      input.version ??
      (
        await tx
          .select({ version: schema.agentVersions.version })
          .from(schema.agentVersions)
          .where(eq(schema.agentVersions.agentId, agent.id))
          .orderBy(desc(schema.agentVersions.version))
          .limit(1)
      )[0]?.version;

    if (targetVersion === undefined) {
      throw new Error(`Agent "${input.agentId}" has no versions to publish`);
    }

    const [version] = await tx
      .select({
        id: schema.agentVersions.id,
        isPublished: schema.agentVersions.isPublished,
        config: schema.agentVersions.config,
      })
      .from(schema.agentVersions)
      .where(
        and(
          eq(schema.agentVersions.agentId, agent.id),
          eq(schema.agentVersions.version, targetVersion),
        ),
      )
      .limit(1);

    if (!version) {
      throw new Error(
        `Version ${targetVersion} not found for agent "${input.agentId}"`,
      );
    }
    if (version.isPublished) {
      throw new Error(
        `Version ${targetVersion} is already published and is immutable`,
      );
    }

    const checksum = computeConfigChecksum(version.config);

    await tx
      .update(schema.agentVersions)
      .set({ isPublished: true, checksum })
      .where(eq(schema.agentVersions.id, version.id));

    await tx
      .update(schema.agents)
      .set({
        activeVersionId: version.id,
        status: "active",
        updatedByUserId: userId,
      })
      .where(
        and(
          eq(schema.agents.id, agent.id),
          eq(schema.agents.workspaceId, ctx.workspaceId),
        ),
      );

    return {
      agentId: agent.publicId,
      version: targetVersion,
      checksum,
      activeVersionId: version.id,
    };
  });
}
