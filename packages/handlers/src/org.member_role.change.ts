// org.member.role.change.ts — handler for the org.member.role.change capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Resolve actor's principal and check they hold Owner or Admin role in the
//      org via principal_role_assignments (IAM, not legacy org_users.role).
//   3. Resolve target membership — verify the target userId belongs to ctx.orgId
//      (IDOR guard: `not_found` if target is not in this org).
//   4. Resolve the requested newRole — must exist as an org-scoped system role
//      (`not_found` otherwise).
//   5. Last-owner guard — `conflict` if demoting the last Owner.
//   6. In a transaction:
//      a. Remove any existing org-scoped role assignments for the principal.
//      b. Insert the new role assignment.
//      c. Update legacy org_users.role to stay consistent.
//   7. Emit org.role_changed security event (fire-and-forget).

import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { schema, withOrgDb, type Tx } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, asc, eq, isNull } from "drizzle-orm";
import { resolveMemberUserId } from "./lib/org-member";
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
        // A member's principal is org-level: iam-provision creates it with no
        // workspace, and an agent principal that shares the same
        // parent_user_id is what the kind filter above excludes. Pinning
        // workspace_id IS NULL says so in the query rather than relying on it,
        // and keeps the read identical under an org-only scope, where
        // iam.principals (workspace_nullable) admits exactly the NULL rows.
        isNull(schema.principals.workspaceId),
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
    throw new HandlerError({
      code: "forbidden",
      reason: "unauthenticated",
      message: "No authenticated principal",
    });
  }
  if (!ctx.orgId) {
    logger.warn({}, "org.member.role.change: rejected — missing orgId");
    throw new HandlerError({
      code: "forbidden",
      reason: "org_scope_required",
      message: "orgId is required",
    });
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Scoped reads + mutation (single org-wide transaction) ────────────────────
  // withOrgDb opens one RLS-scoped transaction ACROSS the organisation's
  // workspaces (ADR-086). Changing a member's ORG role is an organisation-level
  // act and the app invokes it with the org-only workspace sentinel, so
  // `withTenantDb` would now refuse every statement here outright:
  // `iam.principals` and `iam.principal_role_assignments` are
  // `workspace_nullable`, and their policies name the workspace GUC. Before the
  // refusal the same reads were narrowed instead — which happened to be right,
  // because every predicate below already pins `workspace_id IS NULL`, and that
  // pin is what actually says "the org-wide assignment" rather than RLS.
  //
  // The INSERT and UPDATE stay correct under the unchanged WITH CHECK: the rows
  // this handler writes carry `workspace_id` NULL, which `workspace_nullable`
  // admits without consulting the workspace GUC. A row naming a workspace would
  // be refused here, which is right — this capability does not write one.
  //
  // `withOrgDb` resolves the same data plane `withTenantDb` would, so the read
  // does not change database (ADR-074, coverage gap 4).
  //
  // The actor role gate, the IDOR and last-owner guards, plus the role swap all
  // run inside it so they are atomic and RLS-policied; a guard throw rolls back
  // and propagates its HandlerError. Resolving the actor role inside this same
  // transaction (rather than in a prior, separate one) closes a TOCTOU window: a
  // concurrent demotion of the actor between an earlier check and the write
  // could otherwise let a now-unauthorized actor complete the change.
  // Returns the target's previous role for the audit event below.
  const previousRole = await withOrgDb(async (tx) => {
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
      throw new HandlerError({
        code: "forbidden",
        reason: "insufficient_role",
        message: "Only org Owners and Admins can change member roles",
      });
    }

    // ── Resolve the target's user id ────────────────────────────────────────────
    // The console names a member by public id (`usr_…`) and never by uuid, which
    // org_users.user_id is; lib/org-member.ts resolves one form into the other
    // inside this transaction, after the gate, so a caller the org refuses
    // learns nothing about who is in it.
    const target = await resolveMemberUserId(tx, ctx.orgId, input.targetUserId);

    // ── Resolve target membership (IDOR guard) ──────────────────────────────────
    const [targetOrgUser] = await tx
      .select({ id: schema.orgUsers.id, role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, ctx.orgId),
          eq(schema.orgUsers.userId, target),
        ),
      )
      .limit(1);

    if (!targetOrgUser) {
      logger.warn(
        { orgId: ctx.orgId, targetUserId: input.targetUserId },
        "org.member.role.change: target not a member of this org",
      );
      throw new HandlerError({
        code: "not_found",
        reason: "target_not_member",
        message: "Target user is not a member of this org",
      });
    }

    // ── Resolve new role row ────────────────────────────────────────────────────
    // ORDERED, because `iam.roles` is not unique on (org, scope_kind, name) and
    // at least one production organisation carries two 'Owner' rows seeded in
    // the same transaction. An unordered `limit(1)` picks between them by
    // whatever the plan returns first, so the same request can resolve to a
    // different role id on two runs — and an assignment written against one
    // duplicate is invisible to a reader that resolved the other. Oldest wins:
    // it is the row every earlier assignment was written against, so this
    // agrees with the existing grants rather than stranding them.
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
      .orderBy(asc(schema.roles.createdAt), asc(schema.roles.id))
      .limit(1);

    if (!newRoleRow) {
      logger.warn(
        { orgId: ctx.orgId, newRole: input.newRole },
        "org.member.role.change: requested role does not exist in this org",
      );
      // Org-scoped system roles are seeded by bootstrapOrgIAM's ORG_ROLES list
      // (Owner, Admin, Compliance, Billing). "Member" and "Viewer" are
      // WORKSPACE-scoped and are deliberately not offered here.
      throw new HandlerError({
        code: "not_found",
        reason: "role_not_found",
        message: `Role '${input.newRole}' does not exist in this org. Valid org roles: Owner, Admin, Compliance, Billing.`,
      });
    }

    // ── Last-owner guard ──────────────────────────────────────────────────────
    // Block demoting the last Owner to prevent org lockout.
    if (input.newRole !== OWNER_ROLE_NAME) {
      // Same ordering as the resolve above, for the same reason: the guard has
      // to count owners against the SAME 'Owner' row an assignment would be
      // written against, or a duplicate makes the last owner look like none.
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
        .orderBy(asc(schema.roles.createdAt), asc(schema.roles.id))
        .limit(1);

      if (ownerRoleRow) {
        // Find target's principal.
        const [targetPrincipalRow] = await tx
          .select({ id: schema.principals.id })
          .from(schema.principals)
          .where(
            and(
              eq(schema.principals.orgId, ctx.orgId),
              eq(schema.principals.parentUserId, target),
              eq(schema.principals.kind, "human"),
              // A member's principal is org-level: iam-provision creates it with no
              // workspace, and an agent principal that shares the same
              // parent_user_id is what the kind filter above excludes. Pinning
              // workspace_id IS NULL says so in the query rather than relying on it,
              // and keeps the read identical under an org-only scope, where
              // iam.principals (workspace_nullable) admits exactly the NULL rows.
              isNull(schema.principals.workspaceId),
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
              throw new HandlerError({
                code: "conflict",
                reason: "last_owner",
                message:
                  "Cannot demote the last org owner. Promote another member to Owner first.",
              });
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
          eq(schema.principals.parentUserId, target),
          eq(schema.principals.kind, "human"),
          // A member's principal is org-level: iam-provision creates it with no
          // workspace, and an agent principal that shares the same
          // parent_user_id is what the kind filter above excludes. Pinning
          // workspace_id IS NULL says so in the query rather than relying on it,
          // and keeps the read identical under an org-only scope, where
          // iam.principals (workspace_nullable) admits exactly the NULL rows.
          isNull(schema.principals.workspaceId),
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
          deletedById: actorId,
          updatedAt: new Date(),
          updatedById: actorId,
        })
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, targetPrincipalId),
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            isNull(schema.principalRoleAssignments.workspaceId),
            isNull(schema.principalRoleAssignments.deletedAt),
          ),
        );

      // (b) Grant the new role.
      //
      // RESURRECT, never `onConflictDoNothing`. `pra_principal_role_org_null_
      // workspace_uniq` is UNIQUE (principal_id, role_id, org_id) WHERE
      // workspace_id IS NULL, and `deleted_at` is in neither the key nor the
      // predicate — so the row (a) has just soft-deleted STILL OCCUPIES this
      // insert's unique slot. When the new role is one the principal already
      // held, the insert therefore conflicts with the row it is meant to
      // replace, and `onConflictDoNothing` swallowed that as success: the
      // revocation committed, the grant did not, and the member was left
      // holding no org role at all.
      //
      // That is not a theoretical ordering: re-granting the role a member
      // already has is the ordinary no-op an operator performs, and the org's
      // casing drift (`org_users.role` is written 'owner' by the create path
      // and 'Owner' by this one) makes the UI offer it as a real change. On
      // 2026-09-18 it cost the sole Owner of an organisation every grant they
      // had, with no path back through the product — the last-owner guard
      // above cannot catch it, because it only runs when the new role is NOT
      // Owner and here the intent was to stay Owner.
      await tx
        .insert(schema.principalRoleAssignments)
        .values({
          principalId: targetPrincipalId,
          roleId: newRoleRow.id,
          orgId: ctx.orgId,
          assignedBy: actorId,
          createdById: actorId,
          updatedById: actorId,
        })
        .onConflictDoUpdate({
          target: [
            schema.principalRoleAssignments.principalId,
            schema.principalRoleAssignments.roleId,
            schema.principalRoleAssignments.orgId,
          ],
          targetWhere: isNull(schema.principalRoleAssignments.workspaceId),
          set: {
            deletedAt: null,
            deletedById: null,
            assignedBy: actorId,
            assignedAt: new Date(),
            updatedAt: new Date(),
            updatedById: actorId,
          },
        });

      // (b2) The operation's post-condition, asserted rather than assumed.
      //
      // Every branch above is meant to leave the member holding exactly the
      // role just granted. The failure this guards is the one that actually
      // happened: a revocation that commits while its replacement grant does
      // not, which reads as success and is discovered later as an account that
      // can no longer do anything. Inside the transaction a refusal rolls the
      // revocation back, so the member keeps the role they had — strictly
      // better than committing a member into having none.
      const [granted] = await tx
        .select({ id: schema.principalRoleAssignments.id })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, targetPrincipalId),
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            isNull(schema.principalRoleAssignments.workspaceId),
            isNull(schema.principalRoleAssignments.deletedAt),
          ),
        )
        .limit(1);
      if (!granted) {
        throw new Error(
          `org.member.role.change: refusing to commit — the role change would leave the member with no org role (org ${ctx.orgId}, role '${input.newRole}')`,
        );
      }
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
        updatedById: actorId,
      })
      .where(
        and(
          eq(schema.orgUsers.orgId, ctx.orgId),
          eq(schema.orgUsers.userId, target),
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
