import { withTenantDb, schema } from "@oxagen/database";
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
    // Provision the agent's IAM identity FIRST: exactly one iam.principals row
    // (kind='agent', parentUserId=creator) per agent IDENTITY — not per
    // version, not per run (docs/specs/agent-rbac/spec.md §3.1). The principal
    // id is persisted on the agent row below so the two are created together
    // and never drift.
    const [principal] = await tx
      .insert(schema.principals)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        kind: "agent",
        displayName: input.name,
        status: "active",
        parentUserId: userId,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({ id: schema.principals.id });
    if (!principal) throw new Error("principals insert failed");

    // Role assignment is explicitly OUT of scope here — provisioning the
    // agent's IAM identity (this handler) and assigning it a role are
    // separate concerns owned by the role-contracts work
    // (agent.role.assign.ts et al., docs/specs/agent-rbac/spec.md §3.2). A
    // freshly created agent principal carries no role assignment until an
    // explicit agent.role.assign call is made.

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
        principalId: principal.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        id: schema.agents.id,
        publicId: schema.agents.publicId,
        slug: schema.agents.slug,
      });
    if (!agent) throw new Error("agents insert failed");

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
