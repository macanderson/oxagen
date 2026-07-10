import type { CapabilityHandler } from "@oxagen/oxagen";
import { userWorkspacePreferencesRead } from "@oxagen/oxagen/contracts/user.workspace_preferences.read";
// workspace_user_preferences is org/workspace-scoped (RLS) → withTenantDb.
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

/** Defaults returned when no preferences row exists for (user, workspace). */
const WS_PREF_DEFAULTS = {
  defaultRepoConnectionId: null,
  defaultRepoSlug: null,
  defaultEnvironmentId: null,
  defaultAgentId: null,
  repoDefaultPrompted: false,
};

export const userWorkspacePreferencesReadHandler: CapabilityHandler<
  typeof userWorkspacePreferencesRead
> = async (_input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      {},
      "user.workspace-preferences.read: rejected — no authenticated user",
    );
    throw new Error(
      "user.workspace-preferences.read requires an authenticated user",
    );
  }
  if (!ctx.workspaceId) {
    logger.warn(
      { userId: ctx.userId },
      "user.workspace-preferences.read: rejected — no workspace context",
    );
    throw new Error(
      "user.workspace-preferences.read requires a workspace context",
    );
  }

  const userId = ctx.userId;
  const workspaceId = ctx.workspaceId;

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
    logger.info(
      { userId, workspaceId, surface: ctx.surface },
      "user.workspace-preferences.read: no row — returning defaults (never prompted)",
    );
    return WS_PREF_DEFAULTS;
  }

  logger.info(
    { userId, workspaceId, surface: ctx.surface },
    "user.workspace-preferences.read: returned preferences",
  );

  return {
    defaultRepoConnectionId: row.defaultRepoConnectionId ?? null,
    defaultRepoSlug: row.defaultRepoSlug ?? null,
    defaultEnvironmentId: row.defaultEnvironmentId ?? null,
    defaultAgentId: row.defaultAgentId ?? null,
    repoDefaultPrompted: row.repoDefaultPromptedAt != null,
  };
};
