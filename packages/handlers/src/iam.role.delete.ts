// `delete_role`: remove a custom role nobody holds (ADR-057). Org Owner or
// Admin; a system role is refused (`conflict`, `system_role_readonly`) and so
// is a role with an active assignment (`conflict`, `role_in_use`) — a role is
// never deleted out from under a holder. No tier gate: a custom role exists
// only where one was created, and removing it narrows nothing.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { assertCustomRole, roleNotFound } from "./iam.role.grants.set";
import { logger } from "./logger";
import { withRoleStore, type RoleStore } from "./lib/iam-roles";

export function createDeleteRoleHandler(deps: {
  withStore: <T>(fn: (store: RoleStore) => Promise<T>) => Promise<T>;
}): CapabilityHandler<typeof iamRoleDelete> {
  return async (input, ctx) => {
    await assertOrgRole(ctx, { org: ["Owner", "Admin"] });
    const userId = ctx.userId as string;

    const deleted = await deps.withStore(async (store) => {
      const role = await store.roleByPublicId(ctx.orgId, input.roleId);
      if (!role) throw roleNotFound();
      assertCustomRole(role);
      const holders = await store.activeAssignmentCount(ctx.orgId, role.id);
      if (holders > 0) {
        throw new HandlerError({
          code: "conflict",
          reason: "role_in_use",
          message: `${role.name} is held by ${holders} principal${holders === 1 ? "" : "s"}; reassign them first`,
        });
      }
      await store.deleteRole(ctx.orgId, role.id);
      return { id: role.publicId, name: role.name };
    });

    emitSecurityEventAsync({
      eventType: "iam.role_deleted",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: iamRoleDelete.name,
      outcome: "success",
      ip: ctx.clientIp ?? null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, roleId: deleted.id },
        "delete_role: failed to record security event",
      );
    });
    logger.info(
      { orgId: ctx.orgId, roleId: deleted.id },
      "delete_role: role deleted",
    );
    return deleted;
  };
}

export const iamRoleDeleteHandler = createDeleteRoleHandler({
  withStore: withRoleStore,
});
