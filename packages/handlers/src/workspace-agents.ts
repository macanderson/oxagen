// workspace-agents.ts — idempotent seeding of the built-in interactive
// (`qa-chat`) agent for a workspace. Called atomically inside the
// workspace-create transaction, from the dev seed script, and from the backfill
// for existing workspaces.
//
// The seeded agent is the SINGLE interactive agent backing both the MCP server
// and the in-app Q&A surface. It is published (v1), active, and deployed so the
// chat.stream lookup (slug "qa-chat") always resolves to a definition with an
// activeVersionId — letting executions be recorded for the SOC 2 audit trail.

import { schema, withTenantDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import {
  INTERACTIVE_AGENT_SLUG,
  INTERACTIVE_AGENT_NAME,
  INTERACTIVE_AGENT_TYPE,
  INTERACTIVE_AGENT_DESCRIPTION,
  buildInteractiveAgentConfig,
  computeConfigChecksum,
} from "@oxagen/oxagen/interactive-agent";
import { logger } from "./logger";

// ── Args ──────────────────────────────────────────────────────────────────────

export interface BootstrapWorkspaceAgentsArgs {
  workspaceId: string;
  orgId: string;
  userId: string;
  /** Pass the active Drizzle transaction to run atomically inside an existing
   * transaction. When omitted the function opens its own withTenantDb. */
  tx?: Tx;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Idempotently ensure the `qa-chat` interactive agent and its published v1
 * version exist for a workspace, with a schema-conforming config and the agent
 * deployed active.
 *
 * Safe to re-run: a fresh insert creates the agent + published v1 and wires it;
 * an agent that already has an activeVersionId is left untouched; a legacy agent
 * with no activeVersionId (e.g. seeded before configs were populated) is
 * reconciled — its v1 config is backfilled, published, and wired as active.
 */
export async function bootstrapWorkspaceAgents(
  args: BootstrapWorkspaceAgentsArgs,
): Promise<void> {
  const { workspaceId, orgId, userId, tx } = args;
  if (tx) {
    return bootstrapWorkspaceAgentsWithTx(workspaceId, orgId, userId, tx);
  }
  return withTenantDb((dbTx) =>
    bootstrapWorkspaceAgentsWithTx(workspaceId, orgId, userId, dbTx),
  );
}

async function bootstrapWorkspaceAgentsWithTx(
  workspaceId: string,
  orgId: string,
  userId: string,
  d: Tx,
): Promise<void> {
  // The interactive agent reasons over the workspace's ontology; per-workspace
  // convention the ontology id IS the workspace id.
  const config = buildInteractiveAgentConfig(workspaceId);
  const checksum = computeConfigChecksum(config);

  // 1. Upsert the qa-chat agent identity row.
  const [existingAgent] = await d
    .select({
      id: schema.agents.id,
      activeVersionId: schema.agents.activeVersionId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
      ),
    )
    .limit(1);

  let agentId: string;

  if (existingAgent) {
    agentId = existingAgent.id;
    if (existingAgent.activeVersionId) {
      logger.debug(
        { workspaceId, agentId },
        "workspace-agents: qa-chat already published — skipping",
      );
      return;
    }
    // Legacy / partially-seeded agent: fall through to reconcile its v1.
    logger.info(
      { workspaceId, agentId },
      "workspace-agents: reconciling qa-chat with no active version",
    );
  } else {
    // Provision the qa-chat agent's IAM identity too: agents.principal_id is
    // NOT NULL (docs/specs/agent-rbac/spec.md §3.1) — every agent row,
    // built-in or user-created, is created together with its principal in the
    // same transaction, never as a separate/legacy step.
    const [principal] = await d
      .insert(schema.principals)
      .values({
        orgId,
        workspaceId,
        kind: "agent",
        displayName: INTERACTIVE_AGENT_NAME,
        status: "active",
        parentUserId: userId,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({ id: schema.principals.id });
    if (!principal) {
      throw new Error(
        `[workspace-agents] Failed to provision qa-chat principal for workspace ${workspaceId}`,
      );
    }

    const [inserted] = await d
      .insert(schema.agents)
      .values({
        workspaceId,
        orgId,
        slug: INTERACTIVE_AGENT_SLUG,
        name: INTERACTIVE_AGENT_NAME,
        description: INTERACTIVE_AGENT_DESCRIPTION,
        agentType: INTERACTIVE_AGENT_TYPE,
        status: "active",
        deploymentStatus: "active",
        principalId: principal.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.agents.id });

    if (!inserted) {
      // Lost a concurrent-insert race — re-select.
      const [reselected] = await d
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, workspaceId),
            eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
          ),
        )
        .limit(1);

      if (!reselected) {
        throw new Error(
          `[workspace-agents] Failed to upsert qa-chat agent for workspace ${workspaceId}`,
        );
      }
      agentId = reselected.id;
    } else {
      agentId = inserted.id;
      logger.info(
        { workspaceId, agentId },
        "workspace-agents: qa-chat created",
      );
    }
  }

  // 2. Upsert published version 1 with the schema-conforming config.
  const [existingVersion] = await d
    .select({
      id: schema.agentVersions.id,
      isPublished: schema.agentVersions.isPublished,
    })
    .from(schema.agentVersions)
    .where(
      and(
        eq(schema.agentVersions.agentId, agentId),
        eq(schema.agentVersions.version, 1),
      ),
    )
    .limit(1);

  let versionId: string;

  if (existingVersion) {
    versionId = existingVersion.id;
    // Reconcile a legacy empty-config / unpublished v1 in place. Safe because
    // it was never a published immutable version (no activeVersionId existed).
    await d
      .update(schema.agentVersions)
      .set({ config, isPublished: true, checksum })
      .where(eq(schema.agentVersions.id, versionId));
  } else {
    const [insertedVersion] = await d
      .insert(schema.agentVersions)
      .values({
        agentId,
        version: 1,
        isPublished: true,
        checksum,
        config,
        createdByUserId: userId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.agentVersions.id });

    if (!insertedVersion) {
      const [reselectedVersion] = await d
        .select({ id: schema.agentVersions.id })
        .from(schema.agentVersions)
        .where(
          and(
            eq(schema.agentVersions.agentId, agentId),
            eq(schema.agentVersions.version, 1),
          ),
        )
        .limit(1);
      if (!reselectedVersion) {
        throw new Error(
          `[workspace-agents] Failed to upsert qa-chat v1 for agent ${agentId}`,
        );
      }
      versionId = reselectedVersion.id;
    } else {
      versionId = insertedVersion.id;
    }
  }

  // 3. Wire activeVersionId + deploy posture on the agent row.
  await d
    .update(schema.agents)
    .set({
      activeVersionId: versionId,
      status: "active",
      deploymentStatus: "active",
      updatedByUserId: userId,
    })
    .where(eq(schema.agents.id, agentId));

  logger.info(
    { workspaceId, agentId, versionId },
    "workspace-agents: qa-chat v1 published and wired as active version",
  );
}
