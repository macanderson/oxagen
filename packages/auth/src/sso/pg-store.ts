/**
 * The Postgres side of an SSO sign-in's role mapping (ADR-145): reads the
 * group → role table and writes the person's org role.
 *
 * tenancy: system bypass via withSystemDb. The sign-in request that calls
 * this has no tenant scope (the plugin runs before any session exists), so
 * every statement pins `org_id` to the provider's organisation instead. The
 * organisation comes from the provider row, which only the org.sso.*
 * capabilities write, never from anything the identity provider sent.
 *
 * The role write mirrors change_member_role (packages/handlers/src/
 * org.member_role.change.ts): soft-delete the principal's org-wide
 * assignments, resurrect-or-insert the new one with onConflictDoUpdate (never
 * onConflictDoNothing; that handler's comments record the outage it caused),
 * keep org_users.role in step, and assert the post-condition inside the
 * transaction so a grant that did not take rolls the revocation back.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import {
  SSO_IAM_ROLE_NAME,
  type SsoMappableRole,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import { orgHasSso } from "./entitlement";
import type { SsoProvisioningStore } from "./provision";

/** Recorded as the actor on rows SSO writes: the person signing in. */
async function ensureMemberPrincipal(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
        isNull(schema.principals.workspaceId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [user] = await tx
    .select({
      displayName: schema.users.displayName,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const [inserted] = await tx
    .insert(schema.principals)
    .values({
      orgId,
      kind: "human",
      displayName: user?.displayName ?? user?.email ?? userId,
      status: "active",
      parentUserId: userId,
      createdById: userId,
      updatedById: userId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.principals.id });
  if (inserted) return inserted.id;

  // Lost a race with a concurrent sign-in: read the winner's row.
  const [reselected] = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
        isNull(schema.principals.workspaceId),
      ),
    )
    .limit(1);
  if (!reselected) {
    throw new Error(
      `SSO provisioning could not create a principal for user ${userId} in org ${orgId}`,
    );
  }
  return reselected.id;
}

async function revokeOrgWideAssignments(
  tx: Tx,
  orgId: string,
  principalId: string,
  actor: string,
): Promise<void> {
  const now = new Date();
  await tx
    .update(schema.principalRoleAssignments)
    .set({
      deletedAt: now,
      deletedById: actor,
      updatedAt: now,
      updatedById: actor,
    })
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalId),
        eq(schema.principalRoleAssignments.orgId, orgId),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    );
}

async function grantOrgRole(
  tx: Tx,
  orgId: string,
  principalId: string,
  iamRoleName: string,
  actor: string,
): Promise<void> {
  const [roleRow] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.orgId, orgId),
        eq(schema.roles.scopeKind, "org"),
        eq(schema.roles.name, iamRoleName),
      ),
    )
    .limit(1);
  if (!roleRow) {
    throw new Error(
      `SSO provisioning found no '${iamRoleName}' org role in org ${orgId}`,
    );
  }
  const now = new Date();
  await tx
    .insert(schema.principalRoleAssignments)
    .values({
      principalId,
      roleId: roleRow.id,
      orgId,
      assignedBy: actor,
      createdById: actor,
      updatedById: actor,
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
        expiresAt: null,
        assignedBy: actor,
        assignedAt: now,
        updatedAt: now,
        updatedById: actor,
      },
    });

  const [granted] = await tx
    .select({ id: schema.principalRoleAssignments.id })
    .from(schema.principalRoleAssignments)
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalId),
        eq(schema.principalRoleAssignments.orgId, orgId),
        eq(schema.principalRoleAssignments.roleId, roleRow.id),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    )
    .limit(1);
  if (!granted) {
    throw new Error(
      `SSO provisioning granted '${iamRoleName}' in org ${orgId} but the assignment did not take`,
    );
  }
}

async function applyRoleInTx(
  tx: Tx,
  orgId: string,
  userId: string,
  role: SsoMappableRole | null,
): Promise<void> {
  // Re-read inside the transaction: an Owner is never managed by SSO, and a
  // concurrent promotion to Owner must win over this sign-in.
  const [member] = await tx
    .select({ role: schema.orgUsers.role })
    .from(schema.orgUsers)
    .where(
      and(eq(schema.orgUsers.orgId, orgId), eq(schema.orgUsers.userId, userId)),
    )
    .limit(1)
    .for("update");
  if (member?.role.toLowerCase() === "owner") return;

  const principalId = await ensureMemberPrincipal(tx, orgId, userId);
  await revokeOrgWideAssignments(tx, orgId, principalId, userId);

  if (role === null) {
    // Deny by default: no mapped group, no role and no membership. The org
    // gate resolves membership through org_users, so removing the row is
    // what shuts the organisation to this person.
    await tx
      .delete(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, orgId),
          eq(schema.orgUsers.userId, userId),
        ),
      );
    return;
  }

  const iamRoleName = SSO_IAM_ROLE_NAME[role];
  if (iamRoleName) {
    await grantOrgRole(tx, orgId, principalId, iamRoleName, userId);
  }

  const now = new Date();
  await tx
    .insert(schema.orgUsers)
    .values({
      orgId,
      userId,
      role,
      joinedAt: now,
      createdById: userId,
      updatedById: userId,
    })
    .onConflictDoUpdate({
      target: [schema.orgUsers.orgId, schema.orgUsers.userId],
      set: { role, updatedAt: now, updatedById: userId },
    });
}

export function createPgSsoProvisioningStore(): SsoProvisioningStore {
  return {
    entitled: orgHasSso,

    async groupRoles(orgId, providerId) {
      // tenancy: system bypass during SSO sign-in bootstrap, before any session exists; the read is filtered by the provider's orgId and its provider id in the where clause.
      const rows = await withSystemDb((tx) =>
        tx
          .select({
            group: schema.ssoGroupRoles.idpGroup,
            role: schema.ssoGroupRoles.role,
          })
          .from(schema.ssoGroupRoles)
          .where(
            and(
              eq(schema.ssoGroupRoles.orgId, orgId),
              eq(schema.ssoGroupRoles.providerId, providerId),
            ),
          ),
      );
      return rows.map((r) => ({
        group: r.group,
        role: r.role as SsoMappableRole,
      }));
    },

    async currentRole(orgId, userId) {
      // tenancy: system bypass during SSO sign-in bootstrap, before any session exists; every statement is scoped by the provider's orgId, filtered in the where clause.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, orgId),
              eq(schema.orgUsers.userId, userId),
            ),
          )
          .limit(1),
      );
      return row ? row.role.toLowerCase() : null;
    },

    async applyRole({ orgId, userId, role }) {
      // tenancy: system bypass during SSO sign-in bootstrap, before any session exists; every statement is scoped by the provider's orgId, filtered in the where clause.
      await withSystemDb((tx) => applyRoleInTx(tx, orgId, userId, role));
    },
  };
}
