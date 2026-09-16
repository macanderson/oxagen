// `create_role`: a custom role from the permission catalogue (ADR-063).
//
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), for the
//      signed-in user or the creator of the API key (resolveActingUserId).
//   2. Delegation ceiling — every capability the permissions expand to is
//      resolved for the granter; one they do not hold refuses the whole set
//      with the capabilities named. The ceiling resolves through the pure
//      resolver and reads no tier, so it holds on every plan.
//   3. The role row and one `allow` grant per capability, in one transaction.
//      A name already used in the same scope kind, or by another custom
//      role of the org in either scope kind, is a unique index's 23505, read
//      as `conflict` / `role_exists`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { capabilitiesOf } from "@oxagen/oxagen/iam";
import { isUniqueViolation } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { findDelegationCeilingViolations } from "@oxagen/iam";
import { logger } from "./logger";
import { toRoleRow, withRoleStore, type RoleStore } from "./lib/iam-roles";

export type RoleEditorDeps = {
  withStore: <T>(fn: (store: RoleStore) => Promise<T>) => Promise<T>;
};

export async function assertWithinCeiling(
  store: RoleStore,
  args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    capabilityIds: readonly string[];
  },
): Promise<void> {
  const violations = await findDelegationCeilingViolations(store.ceiling, {
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    userId: args.userId,
    conferred: args.capabilityIds.map((capabilityId) => ({
      capabilityId,
      effect: "allow" as const,
    })),
  });
  if (violations.length === 0) return;
  throw new HandlerError({
    code: "forbidden",
    reason: "delegation_ceiling_exceeded",
    message: `A role cannot grant more than you hold: ${violations.join(", ")}`,
  });
}

export function createRoleHandler(
  deps: RoleEditorDeps,
): CapabilityHandler<typeof iamRoleCreate> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    // assertOrgRole refused a call with no acting user.
    const userId = actingUserId as string;
    const capabilityIds = capabilitiesOf(input.permissions);

    const row = await deps.withStore(async (store) => {
      await assertWithinCeiling(store, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId,
        capabilityIds,
      });
      let role;
      try {
        role = await store.insertRole({
          orgId: ctx.orgId,
          name: input.name,
          scopeKind: input.scopeKind,
          description: input.description,
          createdByUserId: userId,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HandlerError({
            code: "conflict",
            reason: "role_exists",
            message: `A role named ${input.name} already exists in this organization`,
          });
        }
        throw err;
      }
      await store.replaceGrants(ctx.orgId, role.id, capabilityIds, userId);
      return toRoleRow(
        role,
        capabilityIds.map((capability) => ({ capability, effect: "allow" })),
        0,
        await store.userName(userId),
      );
    });

    emitSecurityEventAsync({
      eventType: "iam.role_created",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: iamRoleCreate.name,
      outcome: "success",
      ip: ctx.clientIp ?? null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, roleId: row.id },
        "create_role: failed to record security event",
      );
    });
    logger.info(
      { orgId: ctx.orgId, roleId: row.id, permissions: input.permissions },
      "create_role: role created",
    );
    return { role: row };
  };
}

export const iamRoleCreateHandler = createRoleHandler({
  withStore: withRoleStore,
});
