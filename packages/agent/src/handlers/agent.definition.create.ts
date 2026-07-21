import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { agentDefinitionConfigSchema } from "@oxagen/oxagen/agent-schema";
import type {
  AgentDefinitionCreateInput,
  AgentDefinitionCreateOutput,
} from "@oxagen/oxagen/contracts/agent.definition.create";
import type { CapabilityContext } from "../types";
import {
  isManagedAgentType,
  INTERACTIVE_AGENT_SLUG,
} from "@oxagen/oxagen/interactive-agent";
import { AgentManagedReadOnlyError } from "./_agent-definition";

export type { AgentDefinitionCreateInput, AgentDefinitionCreateOutput };

/**
 * Create a new agent definition: the identity row (status 'draft',
 * deploymentStatus 'inactive') plus an immutable, unpublished v1 version whose
 * config is validated against agentDefinitionConfigSchema.
 */
export async function agentDefinitionCreateHandler(
  input: AgentDefinitionCreateInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionCreateOutput> {
  // Validate the config shape before any write so a malformed definition can
  // never be persisted (handlers never trust the column shape).
  const config = agentDefinitionConfigSchema.parse(input.config);

  // Reject attempts to create an agent that masquerades as a product-managed
  // built-in (either by claiming the reserved agentType or the reserved slug).
  if (
    isManagedAgentType(input.agentType) ||
    input.slug === INTERACTIVE_AGENT_SLUG
  ) {
    throw new AgentManagedReadOnlyError(input.slug);
  }

  if (!ctx.userId) {
    throw new Error("agent.definition.create requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const [agent] = await tx
      .insert(schema.agents)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        avatarUrl: input.avatarUrl ?? null,
        agentType: input.agentType,
        status: "draft",
        deploymentStatus: "inactive",
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        id: schema.agents.id,
        publicId: schema.agents.publicId,
        slug: schema.agents.slug,
      });
    if (!agent) throw new Error("agents insert failed");

    // Agent RBAC Phase 1 (docs/specs/agent-rbac/spec.md §2.1, §3.1): every
    // agent IDENTITY gets exactly ONE delegated iam.principals row, provisioned
    // here at creation and never re-provisioned on update/publish (versions
    // change config; identity and role assignments persist). parentUserId is
    // the creating user — the human this agent acts on behalf of for the
    // delegation ceiling (agent effective perms = agent ∩ human).
    const [principal] = await tx
      .insert(schema.principals)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        kind: "agent",
        displayName: input.name,
        parentUserId: userId,
      })
      .returning({ id: schema.principals.id });
    if (!principal) throw new Error("principals insert failed");

    await tx
      .update(schema.agents)
      .set({ principalId: principal.id })
      .where(eq(schema.agents.id, agent.id));

    const [version] = await tx
      .insert(schema.agentVersions)
      .values({
        agentId: agent.id,
        version: 1,
        isPublished: false,
        checksum: null,
        config,
        createdByUserId: userId,
      })
      .returning({ version: schema.agentVersions.version });
    if (!version) throw new Error("agent_versions insert failed");

    return {
      agentId: agent.publicId,
      publicId: agent.publicId,
      slug: agent.slug,
      version: version.version,
    };
  });
}
