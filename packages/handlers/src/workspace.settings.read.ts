import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workspaceSettingsRead,
  type WorkspaceSettingsReadOutput,
} from "@oxagen/oxagen/contracts/workspace.settings.read";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// `description` and `avatarUrl` are real columns on workspace.workspaces
// (description was promoted out of the settings JSONB bag — audit §1.7).
export function mapWorkspaceSettingsRow(row: {
  name: string;
  slug: string;
  avatarUrl: string | null;
  description: string | null;
}): WorkspaceSettingsReadOutput {
  return {
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    avatarUrl: row.avatarUrl ?? null,
  };
}

// Reads workspace.workspaces for the active workspace (RLS limits the row to
// ctx.workspaceId). Kernel handles metering + IAM via invoke().
export const workspaceSettingsReadHandler: CapabilityHandler<
  typeof workspaceSettingsRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.settings.read: rejected — no workspace context",
    );
    throw new Error("workspace.settings.read requires a workspace context");
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { name: true, slug: true, avatarUrl: true, description: true },
    }),
  );

  if (!row) {
    logger.warn(
      { workspaceId: ctx.workspaceId },
      "workspace.settings.read: workspace not found",
    );
    throw new Error("Workspace not found");
  }

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "workspace.settings.read: returned workspace settings",
  );
  return mapWorkspaceSettingsRow(row);
};
