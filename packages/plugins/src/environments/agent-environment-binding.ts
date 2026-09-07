/**
 * Agent ↔ environment bindings.
 *
 * An environment is a named set of secrets (the vault). Binding an agent to
 * one declares which credentials that agent identity may resolve at run time
 * — governance metadata on the agent registry, not runtime state. The
 * sandbox-template half of the old binding left with the runtime (ADR-041);
 * a binding is now environment + primary flag only.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

export interface AgentEnvironmentActor {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
}

export interface AgentEnvironmentBinding {
  id: string;
  agentId: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isPrimary: boolean;
}

// Per-call so there is no schema access at import time.
const bindingColumns = () =>
  ({
    id: schema.agentEnvironmentBindings.id,
    publicId: schema.agentEnvironmentBindings.publicId,
    agentId: schema.agentEnvironmentBindings.agentId,
    environmentInternalId: schema.agentEnvironmentBindings.environmentId,
    isPrimary: schema.agentEnvironmentBindings.isPrimary,
  }) as const;

/** Resolve an environment public id to its internal row (workspace-scoped). */
async function loadEnvironment(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<{ id: string; name: string; slug: string; isActive: boolean }> {
  const [row] = await tx
    .select({
      id: schema.environments.id,
      name: schema.environments.name,
      slug: schema.environments.slug,
      isActive: schema.environments.isActive,
    })
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.workspaceId, workspaceId),
        eq(schema.environments.publicId, publicId),
        isNull(schema.environments.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`[agent-environment] environment not found: ${publicId}`);
  return row;
}

async function bindingSummary(
  tx: Tx,
  row: {
    publicId: string;
    agentId: string;
    environmentInternalId: string;
    isPrimary: boolean;
  },
): Promise<AgentEnvironmentBinding> {
  const [env] = await tx
    .select({
      publicId: schema.environments.publicId,
      name: schema.environments.name,
      slug: schema.environments.slug,
    })
    .from(schema.environments)
    .where(eq(schema.environments.id, row.environmentInternalId))
    .limit(1);
  return {
    id: row.publicId,
    agentId: row.agentId,
    environmentId: env?.publicId ?? row.environmentInternalId,
    environmentName: env?.name ?? "",
    environmentSlug: env?.slug ?? "",
    isPrimary: row.isPrimary,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an agent identifier (internal UUID, `agt_…` public id, or slug) to
 * the internal UUID — `agent_environment_bindings.agent_id` is a uuid column
 * and callers hold the PUBLIC id.
 */
async function resolveAgentInternalId(
  tx: Tx,
  workspaceId: string,
  identifier: string,
): Promise<string> {
  if (UUID_RE.test(identifier)) return identifier;
  const match = identifier.startsWith("agt_")
    ? eq(schema.agents.publicId, identifier)
    : eq(schema.agents.slug, identifier);
  const [row] = await tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        match,
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`[agent-environment] agent not found: ${identifier}`);
  return row.id;
}

export async function bindAgentEnvironment(
  actor: AgentEnvironmentActor,
  input: { agentId: string; environmentId: string; isPrimary?: boolean },
): Promise<AgentEnvironmentBinding> {
  return withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );

    // The first binding becomes primary unless the caller says otherwise.
    const existingForAgent = await tx
      .select({
        id: schema.agentEnvironmentBindings.id,
        environmentInternalId: schema.agentEnvironmentBindings.environmentId,
        isPrimary: schema.agentEnvironmentBindings.isPrimary,
      })
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
        ),
      );
    const agentHasPrimary = existingForAgent.some((b) => b.isPrimary);
    const desiredPrimary = input.isPrimary ?? !agentHasPrimary;

    // Promote atomically: demote the current primary before setting this one.
    if (desiredPrimary) {
      await tx
        .update(schema.agentEnvironmentBindings)
        .set({
          isPrimary: false,
          updatedAt: new Date(),
          updatedByUserId: actor.userId ?? null,
        })
        .where(
          and(
            eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
            eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
            eq(schema.agentEnvironmentBindings.isPrimary, true),
          ),
        );
    }

    const existing = existingForAgent.find(
      (b) => b.environmentInternalId === env.id,
    );
    let publicId: string;
    if (existing) {
      const [updated] = await tx
        .update(schema.agentEnvironmentBindings)
        .set({
          isPrimary: desiredPrimary,
          updatedAt: new Date(),
          updatedByUserId: actor.userId ?? null,
        })
        .where(eq(schema.agentEnvironmentBindings.id, existing.id))
        .returning({ publicId: schema.agentEnvironmentBindings.publicId });
      publicId = updated!.publicId;
    } else {
      const [inserted] = await tx
        .insert(schema.agentEnvironmentBindings)
        .values({
          orgId: actor.orgId,
          workspaceId: actor.workspaceId,
          agentId: agentInternalId,
          environmentId: env.id,
          isPrimary: desiredPrimary,
          createdByUserId: actor.userId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning({ publicId: schema.agentEnvironmentBindings.publicId });
      publicId = inserted!.publicId;
    }

    const [row] = await tx
      .select(bindingColumns())
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.publicId, publicId),
        ),
      )
      .limit(1);
    return bindingSummary(tx, row!);
  });
}

export async function unbindAgentEnvironment(
  actor: AgentEnvironmentActor,
  input: { agentId: string; environmentId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const env = await loadEnvironment(
      tx,
      actor.workspaceId,
      input.environmentId,
    );
    await tx
      .delete(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
          eq(schema.agentEnvironmentBindings.environmentId, env.id),
        ),
      );
  });
  return { ok: true };
}

export async function listAgentBindings(
  actor: AgentEnvironmentActor,
  input: { agentId: string },
): Promise<AgentEnvironmentBinding[]> {
  return withTenantDb(async (tx) => {
    const agentInternalId = await resolveAgentInternalId(
      tx,
      actor.workspaceId,
      input.agentId,
    );
    const rows = await tx
      .select(bindingColumns())
      .from(schema.agentEnvironmentBindings)
      .where(
        and(
          eq(schema.agentEnvironmentBindings.workspaceId, actor.workspaceId),
          eq(schema.agentEnvironmentBindings.agentId, agentInternalId),
        ),
      );
    return Promise.all(rows.map((r) => bindingSummary(tx, r)));
  });
}
