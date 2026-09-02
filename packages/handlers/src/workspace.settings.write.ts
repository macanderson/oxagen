// audit-exempt: workspace-profile field edit (name/slug/description) — no fitting security-event type exists in the taxonomy (no workspace.settings_updated); covered by the kernel capability.invoke_* audit. Do not invent a type.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { mapWorkspaceSettingsRow } from "./workspace.settings.read";
import { logger } from "./logger";

// Postgres unique_violation (SQLSTATE 23505) — workspaces_org_slug_idx fires
// when a slug is already taken by another workspace in the same org. Use the
// shared classifier: drizzle wraps the driver error, so the SQLSTATE lives on
// `.cause` and a top-level-only `err.code` check would miss every real
// violation and leak the raw `Failed query: update …` SQL to the caller.

// Partial update of workspace.workspaces for the active workspace. name, slug,
// avatarUrl and description are all real columns, each set independently — so a
// concurrent prompt.settings.write can no longer clobber description (audit
// §1.7). Kernel handles metering + IAM via invoke().
export const workspaceSettingsWriteHandler: CapabilityHandler<
  typeof workspaceSettingsWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.settings.write: rejected — no workspace context",
    );
    throw new Error("workspace.settings.write requires a workspace context");
  }

  const row = await withTenantDb(async (tx) => {
    const existing = await tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { name: true, slug: true, avatarUrl: true, description: true },
    });
    if (!existing) return null;

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined) updates.slug = input.slug;
    // avatarUrl is a real column: null clears, a string sets, undefined leaves it.
    if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl;
    // description is now a real column too: null clears, a string sets.
    if (input.description !== undefined)
      updates.description = input.description;

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    // Slug-rename capture must precede the UPDATE so a unique-violation throw
    // rolls back the history insert with the rest of the transaction (no
    // dangling history rows pointing at slugs the rename never actually
    // produced).
    const slugChanged =
      input.slug !== undefined && input.slug !== existing.slug;

    try {
      if (slugChanged && input.slug !== undefined) {
        await tx.insert(schema.workspaceSlugHistory).values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          oldSlug: existing.slug,
          newSlug: input.slug,
        });
      }
      await tx
        .update(schema.workspaces)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, ctx.workspaceId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(
          `Slug "${input.slug}" is already in use by another workspace in this org`,
        );
      }
      throw err;
    }

    return tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { name: true, slug: true, avatarUrl: true, description: true },
    });
  });

  if (!row) {
    logger.warn(
      { workspaceId: ctx.workspaceId },
      "workspace.settings.write: workspace not found",
    );
    throw new Error("Workspace not found");
  }

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "workspace.settings.write: updated workspace settings",
  );
  return mapWorkspaceSettingsRow(row);
};
