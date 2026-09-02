import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type {
  AgentDeployInput,
  AgentDeployOutput,
} from "@oxagen/oxagen/contracts/agent.deploy";
import type { CapabilityContext } from "../types";
import { resolveAgent, assertAgentMutable } from "./_agent-definition";

export type { AgentDeployInput, AgentDeployOutput };

/** Typed error: activation attempted without a published active version. */
export class AgentDeployRequiresPublishedVersionError extends Error {
  readonly code = "agent_deploy_requires_published_version";
  constructor(agentId: string) {
    super(
      `Agent "${agentId}" cannot be activated: it has no published active version. Publish a version first.`,
    );
    this.name = "AgentDeployRequiresPublishedVersionError";
  }
}

/**
 * Toggle an agent's deployment posture. Activating requires a published active
 * version (its triggers go live); deactivating is always allowed.
 */
export async function agentDeployHandler(
  input: AgentDeployInput,
  ctx: CapabilityContext,
): Promise<AgentDeployOutput> {
  if (!ctx.userId) {
    throw new Error("agent.deploy requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }
    assertAgentMutable(agent);

    if (input.deploymentStatus === "active") {
      if (!agent.activeVersionId) {
        throw new AgentDeployRequiresPublishedVersionError(input.agentId);
      }
      // Confirm the active version is genuinely published (defends against a
      // stale activeVersionId pointing at an unpublished row).
      const [active] = await tx
        .select({ isPublished: schema.agentVersions.isPublished })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.id, agent.activeVersionId))
        .limit(1);
      if (!active?.isPublished) {
        throw new AgentDeployRequiresPublishedVersionError(input.agentId);
      }
    }

    await tx
      .update(schema.agents)
      .set({
        deploymentStatus: input.deploymentStatus,
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
      deploymentStatus: input.deploymentStatus,
    };
  });
}
