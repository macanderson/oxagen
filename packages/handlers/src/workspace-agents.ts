// workspace-agents.ts — idempotent seeding of the built-in agents for a
// newly created workspace. Called atomically inside the workspace-create
// transaction and from the dev seed script.

import { schema, withTenantDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
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
 * Idempotently insert the `qa-chat` agent and its v1 version for a workspace.
 * Safe to re-run: all writes use onConflictDoNothing.
 *
 * If the agent already has an activeVersionId it is left unchanged; only a
 * newly inserted agent gets its activeVersionId wired up.
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
  // 1. Upsert the qa-chat agent identity row.
  const [existingAgent] = await d
    .select({ id: schema.agents.id, activeVersionId: schema.agents.activeVersionId })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.slug, "qa-chat"),
      ),
    )
    .limit(1);

  let agentId: string;

  if (existingAgent) {
    agentId = existingAgent.id;
    logger.debug(
      { workspaceId, agentId },
      "workspace-agents: qa-chat agent already exists — skipping insert",
    );
  } else {
    const [inserted] = await d
      .insert(schema.agents)
      .values({
        workspaceId,
        orgId,
        slug: "qa-chat",
        name: "QA Chat Agent",
        agentType: "interactive_chat",
        status: "active",
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
            eq(schema.agents.slug, "qa-chat"),
          ),
        )
        .limit(1);

      if (!reselected) {
        throw new Error(
          `[workspace-agents] Failed to upsert qa-chat agent for workspace ${workspaceId}`,
        );
      }
      agentId = reselected.id;
      logger.debug(
        { workspaceId, agentId },
        "workspace-agents: qa-chat agent created by concurrent insert",
      );
    } else {
      agentId = inserted.id;
      logger.info(
        { workspaceId, agentId },
        "workspace-agents: qa-chat agent created",
      );
    }

    // 2. Insert version 1 (only needed for newly created agents).
    const [existingVersion] = await d
      .select({ id: schema.agentVersions.id })
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
    } else {
      const [insertedVersion] = await d
        .insert(schema.agentVersions)
        .values({
          agentId,
          version: 1,
          isPublished: true,
          checksum: null,
          config: {},
          createdByUserId: userId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.agentVersions.id });

      if (!insertedVersion) {
        // Lost race — re-select.
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

      // 3. Wire activeVersionId on the agent row (only for newly created agents).
      await d
        .update(schema.agents)
        .set({ activeVersionId: versionId, updatedByUserId: userId })
        .where(eq(schema.agents.id, agentId));

      logger.info(
        { workspaceId, agentId, versionId },
        "workspace-agents: qa-chat v1 created and wired as active version",
      );
    }
  }
}
