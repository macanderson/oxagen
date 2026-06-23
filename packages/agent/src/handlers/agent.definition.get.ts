import { withTenantDb, schema } from "@oxagen/database";
import { desc, eq } from "drizzle-orm";
import { parseAgentDefinitionConfig } from "@oxagen/oxagen/agent-schema";
import type {
  AgentDefinitionGetInput,
  AgentDefinitionGetOutput,
} from "@oxagen/oxagen/contracts/agent.definition.get";
import type { CapabilityContext } from "../types";
import { resolveAgent, isManagedAgentType } from "./_agent-definition";

export type { AgentDefinitionGetInput, AgentDefinitionGetOutput };

/**
 * Fetch an agent and the config of its active version (or, if unpublished, the
 * latest version). The config is parsed through parseAgentDefinitionConfig so a
 * malformed persisted blob surfaces as a validation error, not silent drift.
 */
export async function agentDefinitionGetHandler(
  input: AgentDefinitionGetInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionGetOutput> {
  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }

    // Prefer the active (published) version; fall back to latest version.
    let versionRow:
      | { version: number; isPublished: boolean; config: unknown }
      | undefined;

    if (agent.activeVersionId) {
      const [active] = await tx
        .select({
          version: schema.agentVersions.version,
          isPublished: schema.agentVersions.isPublished,
          config: schema.agentVersions.config,
        })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.id, agent.activeVersionId))
        .limit(1);
      versionRow = active;
    }

    if (!versionRow) {
      const [latest] = await tx
        .select({
          version: schema.agentVersions.version,
          isPublished: schema.agentVersions.isPublished,
          config: schema.agentVersions.config,
        })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.agentId, agent.id))
        .orderBy(desc(schema.agentVersions.version))
        .limit(1);
      versionRow = latest;
    }

    if (!versionRow) {
      // A definition always has at least its v1 (create inserts it). A missing
      // version means a corrupt row, not an empty config — surface it.
      throw new Error(
        `Agent "${input.agentId}" has no version config to return`,
      );
    }
    const config = parseAgentDefinitionConfig(versionRow.config);

    return {
      agentId: agent.publicId,
      publicId: agent.publicId,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      agentType: agent.agentType,
      status: agent.status,
      deploymentStatus: agent.deploymentStatus,
      version: versionRow.version,
      isPublished: versionRow.isPublished,
      managed: isManagedAgentType(agent.agentType),
      config,
    };
  });
}
