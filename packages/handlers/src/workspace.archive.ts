// `archive_workspace`: freeze a workspace (issue #2964).
//
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29).
//   2. The workspace is resolved by public id in the org (`not_found`); one
//      already archived is refused (`conflict`, `already_archived`).
//   3. `archived_at` and `archived_by_user_id` are written together. From
//      then on `list_workspaces` leaves the row out unless asked; its slug
//      stays taken and everything recorded in it stays readable. Recorded as
//      the `workspace.archived` security event.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export const workspaceArchiveHandler: CapabilityHandler<
  typeof workspaceArchive
> = async (input, ctx) => {
  await assertOrgRole(ctx, { org: ["Owner", "Admin"] });
  const userId = ctx.userId as string;

  const archived = await withTenantDb(async (tx) => {
    const [workspace] = await tx
      .select({
        id: schema.workspaces.id,
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        archivedAt: schema.workspaces.archivedAt,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, ctx.orgId),
          eq(schema.workspaces.publicId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!workspace) {
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_not_found",
      });
    }
    if (workspace.archivedAt !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "already_archived",
        message: `${workspace.name} was archived on ${workspace.archivedAt.toISOString()}`,
      });
    }
    const archivedAt = new Date();
    await tx
      .update(schema.workspaces)
      .set({
        archivedAt,
        archivedByUserId: userId,
        updatedAt: archivedAt,
        updatedByUserId: userId,
      })
      .where(eq(schema.workspaces.id, workspace.id));
    return { ...workspace, archivedAt };
  });

  emitSecurityEventAsync({
    eventType: "workspace.archived",
    actorUserId: userId,
    orgId: ctx.orgId,
    workspaceId: archived.id,
    capability: workspaceArchive.name,
    outcome: "success",
    ip: ctx.clientIp ?? null,
    userAgent: null,
    requestId: ctx.requestId,
  }).catch((err: unknown) => {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: archived.id },
      "archive_workspace: failed to record security event",
    );
  });
  logger.info(
    { orgId: ctx.orgId, workspaceId: archived.id, surface: ctx.surface },
    "archive_workspace: workspace archived",
  );

  return {
    id: archived.publicId,
    slug: archived.slug,
    name: archived.name,
    archivedAt: archived.archivedAt.toISOString(),
  };
};
