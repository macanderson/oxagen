// org.member.remove.ts — handler for the org.member.remove capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Resolve actor's principal and check they hold Owner or Admin role in the
//      org via principal_role_assignments (not the legacy org_users.role string).
//      Refuses with `forbidden`, not `not_found`, because the actor IS a
//      confirmed org member — revealing "you lack permission" is not a leak here.
//   3. Resolve target membership — verify the target userId belongs to ctx.orgId
//      (IDOR guard: `not_found` if target is not in this org).
//   4. Last-owner guard — `conflict` if target is the only remaining org Owner.
//   5. In a transaction:
//      a. Delete the org_users membership row.
//      b. Soft-delete all principal_role_assignments for the target's principal
//         in this org (set deletedAt = now).
//      c. Mark the target's principal status = 'deleted'.
//      d. Delete the org_users membership row.
//      e. Soft-delete the target's CLI session keys in this org.
//   6. Emit org.member_removed security event (fire-and-forget).

import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/auth/cli-auth";
import { and, eq, isNull, count, sql } from "drizzle-orm";
import { logger } from "./logger";

// System org role names that carry Owner privileges.
const OWNER_ROLE_NAME = "Owner";

/** Resolve the internal principal id and their active org role name for a user. */
async function resolveActorPrincipalAndRole(
  orgId: string,
  userId: string,
): Promise<{ principalId: string; roleName: string | null }> {
  return withTenantDb(async (tx) => {
    // Find the principal for this (orgId, userId) pair.
    const [principalRow] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.kind, "human"),
          eq(schema.principals.status, "active"),
        ),
      )
      .limit(1);

    if (!principalRow) return { principalId: "", roleName: null };

    // Resolve their highest-precedence org role via principal_role_assignments → roles.
    // We only check org-scoped (workspaceId IS NULL) roles.
    const [praRow] = await tx
      .select({ roleName: schema.roles.name })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, principalRow.id),
          eq(schema.principalRoleAssignments.orgId, orgId),
          eq(schema.roles.scopeKind, "org"),
          isNull(schema.principalRoleAssignments.workspaceId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .limit(1);

    return { principalId: principalRow.id, roleName: praRow?.roleName ?? null };
  });
}

const AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

export const orgMemberRemoveHandler: CapabilityHandler<
  typeof orgMemberRemove
> = async (input, ctx) => {
  // ── Auth + scope guard ───────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "org.member.remove: rejected — no authenticated principal",
    );
    throw new HandlerError({
      code: "forbidden",
      reason: "unauthenticated",
      message: "No authenticated principal",
    });
  }
  if (!ctx.orgId) {
    logger.warn({}, "org.member.remove: rejected — missing orgId");
    throw new HandlerError({
      code: "forbidden",
      reason: "org_scope_required",
      message: "orgId is required",
    });
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Actor role gate (IAM, not legacy role string) ─────────────────────────────
  // Resolves via principal_role_assignments → roles, mirroring the billing
  // authz gate (billing-authz-role-gate memory). A bare membership is NOT
  // sufficient — the actor must hold Owner or Admin.
  const { roleName: actorRole } = await resolveActorPrincipalAndRole(
    ctx.orgId,
    actorId,
  );
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorId, actorRole },
      "org.member.remove: rejected — insufficient org role",
    );
    throw new HandlerError({
      code: "forbidden",
      reason: "insufficient_role",
      message: "Only org Owners and Admins can remove members",
    });
  }

  // ── Scoped reads + mutation (single tenant-scoped transaction) ────────────────
  // withTenantDb opens one RLS-scoped transaction for the current org. All
  // reads (IDOR + last-owner guards) and the membership/IAM writes run inside
  // it so they are atomic and RLS-policied. A guard throw rolls the (so-far
  // read-only) transaction back and propagates its HandlerError to the surface.
  await withTenantDb(async (tx) => {
    // ── Resolve target membership (IDOR guard) ──────────────────────────────────
    // Verify the target userId belongs to THIS org. `not_found` on mismatch —
    // if the target is not a member of this org, confirm nothing about their
    // existence.
    const [targetOrgUser] = await tx
      .select({ id: schema.orgUsers.id, role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, ctx.orgId),
          eq(schema.orgUsers.userId, input.targetUserId),
        ),
      )
      .limit(1);

    if (!targetOrgUser) {
      logger.warn(
        { orgId: ctx.orgId, targetUserId: input.targetUserId },
        "org.member.remove: target not a member of this org",
      );
      throw new HandlerError({
        code: "not_found",
        reason: "target_not_member",
        message: "Target user is not a member of this org",
      });
    }

    // ── Last-owner guard ───────────────────────────────────────────────────────
    // Prevent removing the final Owner to avoid org lockout. Count active
    // principal_role_assignments for the "Owner" org role within this org.
    const [ownerRoleRow] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, ctx.orgId),
          eq(schema.roles.scopeKind, "org"),
          eq(schema.roles.name, OWNER_ROLE_NAME),
        ),
      )
      .limit(1);

    if (ownerRoleRow) {
      // Count non-deleted active owner assignments in this org.
      const ownerCountResult = await tx
        .select({ n: count() })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            eq(schema.principalRoleAssignments.roleId, ownerRoleRow.id),
            isNull(schema.principalRoleAssignments.workspaceId),
            isNull(schema.principalRoleAssignments.deletedAt),
          ),
        );

      const ownerCount = ownerCountResult[0]?.n ?? 0;

      // Determine if the target is an Owner.
      const [targetPrincipalRow] = await tx
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, ctx.orgId),
            eq(schema.principals.parentUserId, input.targetUserId),
            eq(schema.principals.kind, "human"),
          ),
        )
        .limit(1);

      if (targetPrincipalRow) {
        const [targetPra] = await tx
          .select({ id: schema.principalRoleAssignments.id })
          .from(schema.principalRoleAssignments)
          .where(
            and(
              eq(
                schema.principalRoleAssignments.principalId,
                targetPrincipalRow.id,
              ),
              eq(schema.principalRoleAssignments.roleId, ownerRoleRow.id),
              isNull(schema.principalRoleAssignments.workspaceId),
              isNull(schema.principalRoleAssignments.deletedAt),
            ),
          )
          .limit(1);

        if (targetPra && ownerCount <= 1) {
          logger.warn(
            { orgId: ctx.orgId, targetUserId: input.targetUserId },
            "org.member.remove: blocked — would remove last org owner",
          );
          throw new HandlerError({
            code: "conflict",
            reason: "last_owner",
            message:
              "Cannot remove the last org owner. Transfer ownership first or promote another member to Owner.",
          });
        }
      }
    }

    // ── Remove membership + IAM cleanup ─────────────────────────────────────────
    // (a) Resolve target principal (may not exist for pre-IAM members).
    const [targetPrincipal] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, ctx.orgId),
          eq(schema.principals.parentUserId, input.targetUserId),
          eq(schema.principals.kind, "human"),
        ),
      )
      .limit(1);

    if (targetPrincipal) {
      // (b) Soft-delete all org-scoped principal_role_assignments for this principal.
      await tx
        .update(schema.principalRoleAssignments)
        .set({
          deletedAt: new Date(),
          deletedById: actorId,
          updatedAt: new Date(),
          updatedById: actorId,
        })
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, targetPrincipal.id),
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            isNull(schema.principalRoleAssignments.deletedAt),
          ),
        );

      // (c) Deactivate/soft-delete the principal.
      await tx
        .update(schema.principals)
        .set({
          status: "deleted",
          updatedAt: new Date(),
          updatedById: actorId,
        })
        .where(eq(schema.principals.id, targetPrincipal.id));
    }

    // (d) Delete the org_users membership row.
    await tx
      .delete(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, ctx.orgId),
          eq(schema.orgUsers.userId, input.targetUserId),
        ),
      );

    // (e) Revoke the CLI session keys the target minted in this org. A CLI
    // session key authenticates as its creator, so it must not outlive the
    // membership (resolveApiKey also refuses one whose creator left).
    const revokedAt = new Date();
    await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: revokedAt,
        deletedById: actorId,
        updatedAt: revokedAt,
        updatedById: actorId,
      })
      .where(
        and(
          eq(schema.apiKeys.orgId, ctx.orgId),
          eq(schema.apiKeys.createdById, input.targetUserId),
          sql`${schema.apiKeys.scope}->>'purpose' = ${CLI_SESSION_SCOPE_PURPOSE}`,
          isNull(schema.apiKeys.deletedAt),
        ),
      );
  });

  // ── Emit audit event (fire-and-forget; must not fail the capability) ──────────
  emitSecurityEvent({
    eventType: "org.member_removed",
    actorUserId: actorId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "remove_org_member",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorId,
      targetUserId: input.targetUserId,
      surface: ctx.surface,
    },
    "org.member.remove: member removed",
  );

  return {
    removed: true,
    targetUserId: input.targetUserId,
    orgId: ctx.orgId,
  };
};
