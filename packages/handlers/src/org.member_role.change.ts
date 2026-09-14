// org.member.role.change.ts — handler for the org.member.role.change capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Resolve actor's principal and check they hold Owner or Admin role in the
//      org via principal_role_assignments (IAM, not legacy org_users.role).
//   3. Resolve target membership — verify the target userId belongs to ctx.orgId
//      (IDOR guard: 404 if target is not in this org).
//   4. Resolve the requested newRole — must exist as an org-scoped system role.
//   5. Last-owner guard — block if demoting the last Owner.
//   6. In a transaction:
//      a. Remove any existing org-scoped role assignments for the principal.
//      b. Insert the new role assignment.
//      c. Update legacy org_users.role to stay consistent.
//   7. Emit org.role_changed security event (fire-and-forget).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

const OWNER_ROLE_NAME = "Owner";
const AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

/**
 * Resolve the internal principal id and their active org role name for a user,
 * inside an existing tenant-scoped transaction. Must run in the SAME `tx` as
 * the mutation so the actor authorization check and the role swap are one atomic
 * unit — otherwise a concurrent demotion of the actor between the check and the
 * write would let a now-unauthorized actor complete the change (TOCTOU).
 */
async function resolveActorPrincipalAndRole(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<{ principalId: string; roleName: string | null }> {
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
}

export const orgMemberRoleChangeHandler: CapabilityHandler<
  typeof orgMemberRoleChange
> = async (input, ctx) => {
  // ── Auth + scope guard ───────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "org.member.role.change: rejected — no authenticated principal",
    );
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "org.member.role.change: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required");
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Scoped reads + mutation (single tenant-scoped transaction) ────────────────
  // withTenantDb opens one RLS-scoped transaction for the current org. The actor
  // role gate, the IDOR and last-owner guards, plus the role swap all run inside
  // it so they are atomic and RLS-policied; a guard throw rolls back and
  // propagates a 403/404. Resolving the actor role inside this same transaction
  // (rather than in a prior, separate one) closes a TOCTOU window: a concurrent
  // demotion of the actor between an earlier check and the write could otherwise
  // let a now-unauthorized actor complete the change.
  // Returns the target's previous role for the audit event below.
  const previousRole = await withTenantDb(async (tx) => {
    // ── Actor role gate (IAM, not legacy role string) ──────────────────────────
    const { roleName: actorRole } = await resolveActorPrincipalAndRole(
      tx,
      ctx.orgId,
      actorId,
    );
    if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
      logger.warn(
        { orgId: ctx.orgId, actorId, actorRole },
        "org.member.role.change: rejected — insufficient org role",
      );
      throw new Error(
        "Forbidden: only org Owners and Admins can change member roles",
      );
    }

    // ── Resolve target membership (IDOR guard) ──────────────────────────────────
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
        "org.member.role.change: target not a member of this org",
      );
      throw new Error("Not found: target user is not a member of this org");
    }

    // ── Resolve new role row ────────────────────────────────────────────────────
    const [newRoleRow] = await tx
      .select({ id: schema.roles.id, name: schema.roles.name })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, ctx.orgId),
          eq(schema.roles.scopeKind, "org"),
          eq(schema.roles.name, input.newRole),
        ),
      )
      .limit(1);

    if (!newRoleRow) {
      logger.warn(
        { orgId: ctx.orgId, newRole: input.newRole },
        "org.member.role.change: requested role does not exist in this org",
      );
      // Org-scoped system roles are seeded by bootstrapOrgIAM's ORG_ROLES list
      // (Owner, Admin, Compliance, Billing). "Member" and "Viewer" are
      // WORKSPACE-scoped and are deliberately not offered here.
      throw new Error(
        `Role '${input.newRole}' does not exist in this org. Valid org roles: Owner, Admin, Compliance, Billing.`,
      );
    }

    // ── Last-owner guard ──────────────────────────────────────────────────────
    // Block demoting the last Owner to prevent org lockout.
    if (input.newRole !== OWNER_ROLE_NAME) {
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
        // Find target's principal.
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
          // Check if target currently holds Owner role.
          const [targetOwnerPra] = await tx
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

          if (targetOwnerPra) {
            // Count the org's live Owner assignments. NOTE: this counts
            // assignment rows only — it does NOT join principals to exclude a
            // suspended/disabled Owner principal, so an org whose only usable
            // Owner is this target can still pass the guard when a second,
            // non-active Owner principal holds an undeleted assignment.
            const allOwnerPras = await tx
              .select({ id: schema.principalRoleAssignments.id })
              .from(schema.principalRoleAssignments)
              .where(
                and(
                  eq(schema.principalRoleAssignments.orgId, ctx.orgId),
                  eq(schema.principalRoleAssignments.roleId, ownerRoleRow.id),
                  isNull(schema.principalRoleAssignments.workspaceId),
                  isNull(schema.principalRoleAssignments.deletedAt),
                ),
              );

            if (allOwnerPras.length <= 1) {
              logger.warn(
                {
                  orgId: ctx.orgId,
                  targetUserId: input.targetUserId,
                  newRole: input.newRole,
                },
                "org.member.role.change: blocked — would demote last org owner",
              );
              throw new Error(
                "Cannot demote the last org owner. Promote another member to Owner first.",
              );
            }
          }
        }
      }
    }

    // ── Swap role assignment + update legacy column ─────────────────────────────
    // Resolve the target's principal.
    const [existingPrincipal] = await tx
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

    const targetPrincipalId: string | null = existingPrincipal?.id ?? null;

    if (targetPrincipalId) {
      // (a) Soft-delete all existing org-scoped role assignments for this principal.
      //     We replace the old assignment wholesale rather than patching it in-place
      //     so the audit trail shows a clean revocation + new grant.
      await tx
        .update(schema.principalRoleAssignments)
        .set({
          deletedAt: new Date(),
          deletedByUserId: actorId,
          updatedAt: new Date(),
          updatedByUserId: actorId,
        })
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, targetPrincipalId),
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            isNull(schema.principalRoleAssignments.workspaceId),
            isNull(schema.principalRoleAssignments.deletedAt),
          ),
        );

      // (b) Insert new role assignment.
      await tx
        .insert(schema.principalRoleAssignments)
        .values({
          principalId: targetPrincipalId,
          roleId: newRoleRow.id,
          orgId: ctx.orgId,
          assignedBy: actorId,
          createdByUserId: actorId,
          updatedByUserId: actorId,
        })
        .onConflictDoNothing();
    }

    // (c) Update legacy org_users.role to stay consistent with the IAM layer.
    //     org_users.role is the legacy column; the IAM PRA is authoritative, but
    //     the app currently reads org_users.role for some UI paths, so both must
    //     match.
    await tx
      .update(schema.orgUsers)
      .set({
        role: input.newRole,
        updatedAt: new Date(),
        updatedByUserId: actorId,
      })
      .where(
        and(
          eq(schema.orgUsers.orgId, ctx.orgId),
          eq(schema.orgUsers.userId, input.targetUserId),
        ),
      );

    return targetOrgUser.role;
  });

  // ── Emit audit event (fire-and-forget; must not fail the capability) ──────────
  emitSecurityEvent({
    eventType: "org.role_changed",
    actorUserId: actorId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "change_member_role",
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
      previousRole,
      newRole: input.newRole,
      surface: ctx.surface,
    },
    "org.member.role.change: role changed",
  );

  return {
    changed: true,
    targetUserId: input.targetUserId,
    orgId: ctx.orgId,
    previousRole,
    newRole: input.newRole,
  };
};
