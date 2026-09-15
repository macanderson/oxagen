// audit-exempt: workspace-profile field edit (name/slug/description) — no fitting security-event type exists in the taxonomy (no workspace.settings_updated); covered by the kernel capability.invoke_* audit. Do not invent a type.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { mapWorkspaceSettingsRow } from "./workspace.settings.read";
import { logger } from "./logger";

// Postgres unique_violation (SQLSTATE 23505) — workspaces_org_slug_idx fires
// when a slug is already taken by another workspace in the same org. Use the
// shared classifier: drizzle wraps the driver error, so the SQLSTATE lives on
// `.cause` and a top-level-only `err.code` check would miss every real
// violation and leak the raw `Failed query: update …` SQL to the caller.

const workspaceNotFound = () =>
  new HandlerError({ code: "not_found", reason: "workspace_not_found" });

// Partial update of workspace.workspaces for the workspace `input.workspaceId`
// names in the org, or the active one. name, slug, avatarUrl and description
// are all real columns, each set independently — so a concurrent
// prompt.settings.write can no longer clobber description (audit §1.7).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or Owner or Admin of the
//      workspace the call is scoped to (the contract's defaultRoles; INV-29).
//      From an org scope the workspace leg has no workspace to read, so an
//      org Owner or Admin edits any workspace of the org and nobody else does.
//   2. The target is resolved by public id in the org (`not_found`), the
//      slug rename is captured and the unique index's 23505 reads as
//      `conflict` / `slug_taken`.
export const workspaceSettingsWriteHandler: CapabilityHandler<
  typeof workspaceSettingsWrite
> = async (input, ctx) => {
  await assertOrgRole(ctx, {
    org: ["Owner", "Admin"],
    workspace: ["Owner", "Admin"],
  });

  const row = await withTenantDb(async (tx) => {
    const target = await tx.query.workspaces.findFirst({
      where: input.workspaceId
        ? and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.publicId, input.workspaceId),
          )
        : and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.id, ctx.workspaceId),
          ),
      columns: {
        id: true,
        name: true,
        slug: true,
        avatarUrl: true,
        description: true,
      },
    });
    if (!target) return null;
    const { id: workspaceId, ...existing } = target;

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
          workspaceId,
          oldSlug: existing.slug,
          newSlug: input.slug,
        });
      }
      await tx
        .update(schema.workspaces)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspaceId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HandlerError({
          code: "conflict",
          reason: "slug_taken",
          message: `A workspace with the slug ${input.slug} already exists in this organization`,
        });
      }
      throw err;
    }

    return tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
      columns: { name: true, slug: true, avatarUrl: true, description: true },
    });
  });

  if (!row) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: input.workspaceId ?? ctx.workspaceId },
      "workspace.settings.write: workspace not found",
    );
    throw workspaceNotFound();
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: input.workspaceId ?? ctx.workspaceId,
      surface: ctx.surface,
    },
    "workspace.settings.write: updated workspace settings",
  );
  return mapWorkspaceSettingsRow(row);
};
