import type { CapabilityHandler } from "@oxagen/oxagen";
import { userWorkspacePreferencesRead } from "@oxagen/oxagen/contracts/user.workspace_preferences.read";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Read the calling user's per-workspace coding-agent defaults. Tenant-scoped
 * (org + workspace) and keyed to the authenticated user. Absent row ⇒ no
 * defaults set and the one-time repo-default prompt has never been shown.
 */
export const userWorkspacePreferencesReadHandler: CapabilityHandler<
  typeof userWorkspacePreferencesRead
> = async (_input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "user.workspace-preferences.read: rejected — no authenticated user",
    );
    throw new Error(
      "get_workspace_user_preferences requires an authenticated user",
    );
  }
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId, userId: ctx.userId },
      "user.workspace-preferences.read: rejected — no workspace context",
    );
    throw new Error("get_workspace_user_preferences requires a workspace context");
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaceUserPreferences.findFirst({
      where: and(
        eq(schema.workspaceUserPreferences.userId, ctx.userId!),
        eq(schema.workspaceUserPreferences.workspaceId, ctx.workspaceId!),
      ),
      columns: {
        defaultRepoConnectionId: true,
        defaultRepoSlug: true,
        defaultEnvironmentId: true,
        repoDefaultPromptedAt: true,
      },
    }),
  );

  return {
    defaultRepoConnectionId: row?.defaultRepoConnectionId ?? null,
    defaultRepoSlug: row?.defaultRepoSlug ?? null,
    defaultEnvironmentId: row?.defaultEnvironmentId ?? null,
    repoDefaultPrompted: row?.repoDefaultPromptedAt != null,
  };
};
