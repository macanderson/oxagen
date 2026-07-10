import type { CapabilityHandler } from "@oxagen/oxagen";
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";
// workspace_user_preferences is org/workspace-scoped (RLS) → withTenantDb.
import { schema, withTenantDb } from "@oxagen/database";
import type { NewWorkspaceUserPreferences } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export const userWorkspacePreferencesWriteHandler: CapabilityHandler<
  typeof userWorkspacePreferencesWrite
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      {},
      "user.workspace-preferences.write: rejected — no authenticated user",
    );
    throw new Error(
      "user.workspace-preferences.write requires an authenticated user",
    );
  }
  if (!ctx.workspaceId || !ctx.orgId) {
    logger.warn(
      { userId: ctx.userId },
      "user.workspace-preferences.write: rejected — no workspace context",
    );
    throw new Error(
      "user.workspace-preferences.write requires a workspace context",
    );
  }

  const userId = ctx.userId;
  const workspaceId = ctx.workspaceId;
  const orgId = ctx.orgId;
  const now = new Date();
  const promptedAt = input.markRepoPrompted ? now : undefined;

  // Insert values for the first-write case — provided fields, else column
  // defaults (NULL). markRepoPrompted stamps the one-time prompt as answered.
  const insertValues: NewWorkspaceUserPreferences = {
    userId,
    orgId,
    workspaceId,
    createdByUserId: userId,
    updatedByUserId: userId,
    ...("defaultRepoConnectionId" in input
      ? { defaultRepoConnectionId: input.defaultRepoConnectionId }
      : {}),
    ...("defaultRepoSlug" in input
      ? { defaultRepoSlug: input.defaultRepoSlug }
      : {}),
    ...("defaultEnvironmentId" in input
      ? { defaultEnvironmentId: input.defaultEnvironmentId }
      : {}),
    ...("defaultAgentId" in input
      ? { defaultAgentId: input.defaultAgentId }
      : {}),
    ...(promptedAt ? { repoDefaultPromptedAt: promptedAt } : {}),
  };

  // Partial update — only touch fields explicitly provided; leave the rest.
  const updateSet: Partial<NewWorkspaceUserPreferences> & {
    updatedByUserId: string;
  } = {
    updatedByUserId: userId,
    updatedAt: now,
  };
  if ("defaultRepoConnectionId" in input)
    updateSet.defaultRepoConnectionId = input.defaultRepoConnectionId;
  if ("defaultRepoSlug" in input)
    updateSet.defaultRepoSlug = input.defaultRepoSlug;
  if ("defaultEnvironmentId" in input)
    updateSet.defaultEnvironmentId = input.defaultEnvironmentId;
  if ("defaultAgentId" in input)
    updateSet.defaultAgentId = input.defaultAgentId;
  if (promptedAt) updateSet.repoDefaultPromptedAt = promptedAt;

  await withTenantDb((tx) =>
    tx
      .insert(schema.workspaceUserPreferences)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [
          schema.workspaceUserPreferences.userId,
          schema.workspaceUserPreferences.workspaceId,
        ],
        set: updateSet,
      }),
  );

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
        defaultAgentId: true,
        repoDefaultPromptedAt: true,
      },
    }),
  );

  if (!row) {
    throw new Error(
      "user.workspace-preferences.write: upserted row not found on re-read",
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
    defaultAgentId: row.defaultAgentId ?? null,
    repoDefaultPrompted: row.repoDefaultPromptedAt != null,
  };
};
