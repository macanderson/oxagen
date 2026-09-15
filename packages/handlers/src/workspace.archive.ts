// `archive_workspace`: archive a workspace (issue #2964).
//
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), for the
//      signed-in user or the creator of the API key (resolveActingUserId).
//   2. The workspace is resolved by public id in the org (`not_found`); one
//      already archived is refused (`conflict`, `already_archived`).
//   3. A workspace with a registered agent is refused (`conflict`,
//      `workspace_has_agents`): every agent row that is not deleted, not
//      archived and not the built-in `qa-chat` agent each workspace is seeded
//      with. `agent.agents` is workspace-scoped under RLS, so the count and the
//      write run in the target workspace's scope.
//   4. `archived_at` and `archived_by_user_id` are written together. From
//      then on `list_workspaces` leaves the row out unless asked; its slug
//      stays taken and everything recorded in it stays readable. Recorded as
//      the `workspace.archived` security event. The write matches only a row
//      still unarchived; when a concurrent archive got there first it changes
//      nothing and the call is refused with `already_archived`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { INTERACTIVE_AGENT_SLUG } from "@oxagen/oxagen/interactive-agent";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";

export const workspaceArchiveHandler: CapabilityHandler<
  typeof workspaceArchive
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const workspace = await withTenantDb(async (tx) => {
    const [row] = await tx
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
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_not_found",
      });
    }
    if (row.archivedAt !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "already_archived",
        message: `${row.name} was archived on ${row.archivedAt.toISOString()}`,
      });
    }
    return row;
  });

  const archived = await runInTenantScope(
    {
      ...getPrincipalAttribution(),
      orgId: ctx.orgId,
      workspaceId: workspace.id,
    },
    () =>
      withTenantDb(async (tx) => {
        const [agents] = await tx
          .select({ n: count() })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.orgId, ctx.orgId),
              eq(schema.agents.workspaceId, workspace.id),
              ne(schema.agents.status, "archived"),
              ne(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
              isNull(schema.agents.deletedAt),
            ),
          );
        const registered = agents?.n ?? 0;
        if (registered > 0) {
          throw new HandlerError({
            code: "conflict",
            reason: "workspace_has_agents",
            message: `${workspace.name} has ${registered} registered agent(s); deregister or move them first`,
          });
        }
        const archivedAt = new Date();
        // The write repeats the `archived_at is null` check, so of two
        // concurrent archives of one workspace only one changes the row.
        const [written] = await tx
          .update(schema.workspaces)
          .set({
            archivedAt,
            archivedByUserId: userId,
            updatedAt: archivedAt,
            updatedByUserId: userId,
          })
          .where(
            and(
              eq(schema.workspaces.id, workspace.id),
              isNull(schema.workspaces.archivedAt),
            ),
          )
          .returning({ id: schema.workspaces.id });
        if (!written) {
          throw new HandlerError({
            code: "conflict",
            reason: "already_archived",
            message: `${workspace.name} is already archived`,
          });
        }
        return { ...workspace, archivedAt };
      }),
  );

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
