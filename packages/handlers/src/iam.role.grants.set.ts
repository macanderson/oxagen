// `set_role_grants`: replace a custom role's grants with a permission set
// (ADR-063). The same four steps as `create_role` — role gate, tier gate,
// delegation ceiling, one transaction — over an existing role, which must
// be one of the org's (`not_found`) and not a system role (`conflict`,
// `system_role_readonly`: built-in roles are read-only; duplicating is the
// path to a custom one).
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { capabilitiesOf } from "@oxagen/oxagen/iam";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  assertRolesEnforced,
  assertWithinCeiling,
  type RoleEditorDeps,
} from "./iam.role.create";
import { logger } from "./logger";
import { toRoleRow, withRoleStore, type RoleRecord } from "./lib/iam-roles";
import { roleEnforcementOf } from "./lib/org-tier";

export const roleNotFound = () =>
  new HandlerError({ code: "not_found", reason: "role_not_found" });

export function assertCustomRole(role: RoleRecord): void {
  if (!role.isSystemDefault) return;
  throw new HandlerError({
    code: "conflict",
    reason: "system_role_readonly",
    message: `${role.name} is a built-in role; duplicate it to change its grants`,
  });
}

export function createSetRoleGrantsHandler(
  deps: RoleEditorDeps,
): CapabilityHandler<typeof iamRoleGrantsSet> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    // assertOrgRole refused a call with no acting user.
    const userId = actingUserId as string;
    assertRolesEnforced(await deps.enforcement(ctx));
    const capabilityIds = capabilitiesOf(input.permissions);

    const row = await deps.withStore(async (store) => {
      const role = await store.roleByPublicId(ctx.orgId, input.roleId);
      if (!role) throw roleNotFound();
      assertCustomRole(role);
      await assertWithinCeiling(store, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId,
        capabilityIds,
      });
      await store.replaceGrants(ctx.orgId, role.id, capabilityIds, userId);
      return toRoleRow(
        role,
        capabilityIds.map((capability) => ({ capability, effect: "allow" })),
        await store.activeAssignmentCount(ctx.orgId, role.id),
        role.createdByUserId
          ? await store.userName(role.createdByUserId)
          : null,
      );
    });

    emitSecurityEventAsync({
      eventType: "iam.role_grants_set",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: iamRoleGrantsSet.name,
      outcome: "success",
      ip: ctx.clientIp ?? null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, roleId: row.id },
        "set_role_grants: failed to record security event",
      );
    });
    logger.info(
      { orgId: ctx.orgId, roleId: row.id, permissions: input.permissions },
      "set_role_grants: grants replaced",
    );
    return { role: row };
  };
}

export const iamRoleGrantsSetHandler = createSetRoleGrantsHandler({
  withStore: withRoleStore,
  enforcement: roleEnforcementOf,
});
