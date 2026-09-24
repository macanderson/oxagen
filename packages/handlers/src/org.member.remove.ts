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
//   5. In the same transaction, removeOrgMemberInTx (shared with the SSO deny
//      sign-in and SCIM deprovisioning, @oxagen/database/member-lifecycle):
//      role assignments at every scope, the principal, the org_users and
//      workspace_users rows, and the target's CLI session keys.
//   6. Emit org.member_removed security event (fire-and-forget).
//
// WHY withSystemDb AND NOT withTenantDb: removal is an organization-level act
// and the app invokes it with the org-only workspace sentinel as ctx.workspaceId
// (apps/app_deprecated/src/app/[orgSlug]/members/member-actions.ts). Three of
// the tables written here are scoped by workspace in Postgres —
// `iam.principal_role_assignments` and `iam.principals` are `workspace_nullable`,
// `auth.api_keys` is `standard`, `workspace.workspace_users` is `workspace_only`
// (packages/database/src/tenant-policy.manifest.ts) — so under that sentinel the
// RLS USING clause admitted only rows carrying no workspace, or no rows at all.
// The role revocation deliberately omits a workspace predicate because its intent is to
// revoke the principal's roles at EVERY scope; RLS narrowed it back to the
// org-wide ones and the UPDATE touched nothing else, silently. Marking the
// principal deleted does not compensate: packages/iam/src/fetch-authz.ts resolves a principal on
// (orgId, parentUserId, kind='human') with no status filter, and iam-provision's
// onConflictDoNothing reuses that same row when the person is invited back, so
// the surviving workspace-scoped assignments come back with them.
//
// Tenant isolation is enforced HERE instead, explicitly: every statement below
// carries eq(orgId), and the two revocations assert the row count they touched
// rather than trusting a silent UPDATE. This is the shape
// packages/handlers/src/iam.role.list.ts documents over the same tables.
//
// WHICH PLANE (ADR-042, and ADR-074's Decision 2 requires this to be stated):
// shared for every table touched here. ADR-042 §2 names `iam`, `org` and `auth`
// among the platform tables that always live on the shared plane; the two
// `workspace.*` tables are org structure rather than tenant data — that list is
// traces, evidence, graph, memory, context records, conversations and ingestion
// state — and the app's own new-workspace action creates both through
// withSystemDb. So the data-plane resolution and assertDataPlaneUsable that
// withTenantDb was doing guarded a binding none of these tables follow, and
// nothing reachable is lost by dropping them. See
// apps/app_deprecated/src/lib/audit-query.ts for the full reasoning, and
// billing.evidence_retention.ts for the opposite case — a table ADR-042 §2
// calls tenant data, which carries the two calls explicitly.

import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { removeOrgMemberInTx } from "@oxagen/database/member-lifecycle";
import { and, eq, isNull, count } from "drizzle-orm";
import { resolveMemberUserId } from "./lib/org-member";
import { logger } from "./logger";

// System org role names that carry Owner privileges.
const OWNER_ROLE_NAME = "Owner";

/** Resolve the internal principal id and their active org role name for a user. */
async function resolveActorPrincipalAndRole(
  orgId: string,
  userId: string,
): Promise<{ principalId: string; roleName: string | null }> {
  // withSystemDb with eq(orgId) on both queries, for the reason in the header.
  return withSystemDb(async (tx) => {
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

  // ── Fenced reads + mutation (single transaction) ──────────────────────────────
  // One transaction for the current org. All reads (IDOR + last-owner guards)
  // and the membership/IAM writes run inside it so they are atomic. A guard
  // throw rolls the (so-far read-only) transaction back and propagates its
  // HandlerError to the surface. Every statement fences on ctx.orgId — see the
  // header for why that fence, not RLS, is the isolation here.
  // tenancy: every statement is filtered by orgId = ctx.orgId after the verified Owner or Admin membership check above.
  await withSystemDb(async (tx) => {
    // ── Resolve the target's user id ────────────────────────────────────────────
    // The console names a member by public id (`usr_…`) and never by uuid, which
    // org_users.user_id is; lib/org-member.ts resolves one form into the other,
    // bounded by this org, after the actor gate above.
    const target = await resolveMemberUserId(tx, ctx.orgId, input.targetUserId);

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
          eq(schema.orgUsers.userId, target),
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
            eq(schema.principals.parentUserId, target),
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
              eq(schema.principalRoleAssignments.orgId, ctx.orgId),
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
    // The shared removal transaction (@oxagen/database/member-lifecycle), which
    // an SSO deny sign-in and a SCIM deprovision also run. For a manual
    // removal it:
    //   - soft-deletes EVERY live role assignment of the target's principal in
    //     this org, org-wide and workspace-scoped alike (no workspace
    //     predicate: the orgId + principalId pair is the fence), and marks the
    //     principal deleted;
    //   - deletes the org_users row and the target's workspace_users rows in
    //     this org's workspaces, so an invitation back does not restore
    //     workspace access before anyone grants it;
    //   - soft-deletes the CLI session keys the target minted here, because a
    //     CLI session key authenticates as its creator, and writes an
    //     api_key.revoked row for each.
    // Sessions stay: a session is the person's, not this org's, and a manual
    // removal from one org must not sign them out of the others.
    const removal = await removeOrgMemberInTx(tx, {
      orgId: ctx.orgId,
      userId: target,
      actorId,
      trigger: "manual",
      endSessions: false,
      keys: "cli_sessions",
      refuseOwner: false,
      principalStatus: "deleted",
      summaryEvent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      {
        orgId: ctx.orgId,
        revokedAssignments: removal.roleAssignmentsRevoked,
        removedWorkspaceMemberships: removal.workspaceMembershipsRemoved,
        revokedCliKeys: removal.apiKeyIds.length,
      },
      "org.member.remove: membership, roles and CLI session keys removed",
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
