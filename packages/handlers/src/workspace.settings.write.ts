import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { mapWorkspaceSettingsRow } from "./workspace.settings.read";
import { logger } from "./logger";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Postgres unique_violation — workspaces_org_slug_idx fires when a slug is
// already taken by another workspace in the same org.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Partial update of workspace.workspaces for the active workspace. name/slug are
// columns; description lives in the settings JSONB bag (read-merge-write so other
// settings keys survive). Kernel handles metering + IAM via invoke().
export const workspaceSettingsWriteHandler: CapabilityHandler<typeof workspaceSettingsWrite> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    logger.warn({ orgId: ctx.orgId }, "workspace.settings.write: rejected — no workspace context");
    throw new Error("workspace.settings.write requires a workspace context");
  }

  const row = await withTenantDb(async (tx) => {
    const existing = await tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { name: true, slug: true, settings: true },
    });
    if (!existing) return null;

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined) updates.slug = input.slug;

    // description is a key inside the settings JSONB bag — merge, don't clobber.
    if (input.description !== undefined) {
      const settings = isRecord(existing.settings) ? { ...existing.settings } : {};
      if (input.description === null) {
        delete settings.description;
      } else {
        settings.description = input.description;
      }
      updates.settings = settings;
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    try {
      await tx
        .update(schema.workspaces)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, ctx.workspaceId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`Slug "${input.slug}" is already in use by another workspace in this org`);
      }
      throw err;
    }

    return tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { name: true, slug: true, settings: true },
    });
  });

  if (!row) {
    logger.warn({ workspaceId: ctx.workspaceId }, "workspace.settings.write: workspace not found");
    throw new Error("Workspace not found");
  }

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "workspace.settings.write: updated workspace settings",
  );
  return mapWorkspaceSettingsRow(row);
};
