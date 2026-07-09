import type { CapabilityHandler } from "@oxagen/oxagen";
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";
import { schema, withTenantDb } from "@oxagen/database";
import type { NewWorkspaceUserPreferences } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Update the calling user's per-workspace coding-agent defaults (partial update:
 * omitted field ⇒ unchanged, null ⇒ cleared, value ⇒ set). Tenant-scoped
 * (org + workspace), keyed to the authenticated user, 1:1 per (user, workspace).
 * `markRepoPrompted` stamps the one-time repo-default prompt as answered.
 */
export const userWorkspacePreferencesWriteHandler: CapabilityHandler<
  typeof userWorkspacePreferencesWrite
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "user.workspace-preferences.write: rejected — no authenticated user",
    );
    throw new Error(
      "update_workspace_user_preferences requires an authenticated user",
    );
  }
  if (!ctx.workspaceId || !ctx.orgId) {
    logger.warn(
      { orgId: ctx.orgId, userId: ctx.userId },
      "user.workspace-preferences.write: rejected — no workspace context",
    );
    throw new Error(
      "update_workspace_user_preferences requires a workspace context",
    );
  }

  const userId = ctx.userId;
  const workspaceId = ctx.workspaceId;
  const orgId = ctx.orgId;

  // Only fields explicitly present in the input mutate; "in input" distinguishes
  // an omitted field (leave unchanged) from an explicit null (clear the value).
  const patch: Partial<NewWorkspaceUserPreferences> = {};
  if ("defaultRepoConnectionId" in input)
    patch.defaultRepoConnectionId = input.defaultRepoConnectionId ?? null;
  if ("defaultRepoSlug" in input)
    patch.defaultRepoSlug = input.defaultRepoSlug ?? null;
  if ("defaultEnvironmentId" in input)
    patch.defaultEnvironmentId = input.defaultEnvironmentId ?? null;
  if (input.markRepoPrompted === true) patch.repoDefaultPromptedAt = new Date();

  const existing = await withTenantDb((tx) =>
    tx.query.workspaceUserPreferences.findFirst({
      where: and(
        eq(schema.workspaceUserPreferences.userId, userId),
        eq(schema.workspaceUserPreferences.workspaceId, workspaceId),
      ),
      columns: { id: true },
    }),
  );

  if (existing) {
    await withTenantDb((tx) =>
      tx
        .update(schema.workspaceUserPreferences)
        .set({ ...patch, updatedByUserId: userId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workspaceUserPreferences.userId, userId),
            eq(schema.workspaceUserPreferences.workspaceId, workspaceId),
          ),
        ),
    );
  } else {
    await withTenantDb((tx) =>
      tx.insert(schema.workspaceUserPreferences).values({
        orgId,
        workspaceId,
        userId,
        createdByUserId: userId,
        updatedByUserId: userId,
        ...patch,
      }),
    );
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaceUserPreferences.findFirst({
      where: and(
        eq(schema.workspaceUserPreferences.userId, userId),
        eq(schema.workspaceUserPreferences.workspaceId, workspaceId),
      ),
      columns: {
        defaultRepoConnectionId: true,
        defaultRepoSlug: true,
        defaultEnvironmentId: true,
        repoDefaultPromptedAt: true,
      },
    }),
  );

  if (!row) {
    throw new Error(
      "update_workspace_user_preferences: upserted row not found on re-read",
    );
  }

  logger.info(
    { userId, workspaceId, surface: ctx.surface },
    "user.workspace-preferences.write: preferences updated",
  );

  return {
    defaultRepoConnectionId: row.defaultRepoConnectionId ?? null,
    defaultRepoSlug: row.defaultRepoSlug ?? null,
    defaultEnvironmentId: row.defaultEnvironmentId ?? null,
    repoDefaultPrompted: row.repoDefaultPromptedAt != null,
  };
};
