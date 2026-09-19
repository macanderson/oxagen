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
//   5. Live API keys bound to the workspace are counted in the same
//      transaction and returned as `suspendedApiKeys`. Archival does not touch
//      the key rows: under ADR-104 `resolveApiKey` refuses a key whose
//      workspace is archived, so those keys stop authenticating the moment the
//      row is written and start working again if the workspace is restored.
//      The count is what the operator is told, and what the audit trail keeps.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { INTERACTIVE_AGENT_SLUG } from "@oxagen/oxagen/interactive-agent";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, count, eq, gt, isNull, ne, or } from "drizzle-orm";
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
        // Locks the workspace row for the rest of this transaction, the same
        // way `create_api_key` locks it before checking `archivedAt`
        // (`api.key.create.ts`). Without this, a `create_api_key` that starts
        // after the count below but before the write commits could acquire
        // its own lock, insert a key, and commit while this transaction still
        // waits — a key `suspendedApiKeys` and the audit log would then omit,
        // even though ADR-104 still stops it from authenticating once this
        // commits. The two `FOR UPDATE`s make the two capabilities queue for
        // the same row: whichever commits first is the order the other sees.
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace.id))
          .for("update");
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
        // Keys that would still authenticate today. ADR-104 stops them at
        // `resolveApiKey` once the row below is written; nothing here revokes
        // them, so the number is a report, not a destruction. An expired or
        // revoked key is already dead and is not counted.
        const [liveKeys] = await tx
          .select({ n: count() })
          .from(schema.apiKeys)
          .where(
            and(
              eq(schema.apiKeys.orgId, ctx.orgId),
              eq(schema.apiKeys.workspaceId, workspace.id),
              isNull(schema.apiKeys.deletedAt),
              or(
                isNull(schema.apiKeys.expiresAt),
                gt(schema.apiKeys.expiresAt, archivedAt),
              ),
            ),
          );
        const suspendedApiKeys = liveKeys?.n ?? 0;
        // The write repeats the `archived_at is null` check, so of two
        // concurrent archives of one workspace only one changes the row.
        const [written] = await tx
          .update(schema.workspaces)
          .set({
            archivedAt,
            archivedByUserId: userId,
            updatedAt: archivedAt,
            updatedById: userId,
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
        return { ...workspace, archivedAt, suspendedApiKeys };
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
    {
      orgId: ctx.orgId,
      workspaceId: archived.id,
      surface: ctx.surface,
      suspendedApiKeys: archived.suspendedApiKeys,
    },
    "archive_workspace: workspace archived",
  );

  return {
    id: archived.publicId,
    slug: archived.slug,
    name: archived.name,
    archivedAt: archived.archivedAt.toISOString(),
    suspendedApiKeys: archived.suspendedApiKeys,
  };
};
