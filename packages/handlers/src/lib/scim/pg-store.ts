// The Postgres port of the SCIM service (#3734). One instance serves one
// request inside one withSystemDb transaction, and every statement is fenced
// on the organization the request's token named.
//
// Where SCIM state lives:
//   - a SCIM user is a person with a human principal in this organization;
//     `principals.idp_subject` holds the identity provider's externalId and
//     `principals.metadata.scim` the name parts Oxagen has no column for;
//   - `metadata.scim_deprovisioned_at` (with status `suspended`) marks a
//     deprovisioned person, which is what keeps an SSO sign-in from
//     re-admitting them (member-lifecycle.ts, isScimSuspended);
//   - `metadata.scim_deleted_at` marks a person the identity provider deleted,
//     so GET answers 404 for them until a POST provisions them again.
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { operatorUserJoin, schema, type Tx } from "@oxagen/database";
import {
  applyMappedOrgRoleInTx,
  isOrgOwner,
  removeOrgMemberInTx,
} from "@oxagen/database/member-lifecycle";
import { emitSecurityEventIn } from "@oxagen/database/security";
import type { SsoMappableRole } from "@oxagen/oxagen/contracts/org.sso.shared";
import { isScimId, ScimError, type ScimEqFilter } from "./protocol";
import type {
  ScimGroupRow,
  ScimNameInput,
  ScimStore,
  ScimUserRow,
} from "./service";

const CAPABILITY = "execute_scim_request";

type Metadata = Record<string, unknown>;

function scimName(metadata: unknown): {
  givenName: string | null;
  familyName: string | null;
} {
  const scim =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Metadata).scim
      : undefined;
  const s = typeof scim === "object" && scim !== null ? (scim as Metadata) : {};
  return {
    givenName: typeof s.givenName === "string" ? s.givenName : null,
    familyName: typeof s.familyName === "string" ? s.familyName : null,
  };
}

function hasMarker(metadata: unknown, key: string): boolean {
  return typeof metadata === "object" && metadata !== null && key in metadata;
}

/** Not deleted by the identity provider. */
const notScimDeleted = sql`NOT (${schema.principals.metadata} ? 'scim_deleted_at')`;

export function createPgScimStore(
  tx: Tx,
  orgId: string,
  requestId: string | null,
): ScimStore {
  const principalOf = (userId: string) =>
    and(
      eq(schema.principals.orgId, orgId),
      eq(schema.principals.parentUserId, userId),
      eq(schema.principals.kind, "human"),
      isNull(schema.principals.workspaceId),
    );

  const userColumns = {
    id: schema.users.id,
    email: schema.users.email,
    // The principal's name, not the shared account's: SCIM renames the
    // account only for an identity this organization owns.
    displayName: schema.principals.displayName,
    createdAt: schema.users.createdAt,
    updatedAt: schema.users.updatedAt,
    externalId: schema.principals.idpSubject,
    metadata: schema.principals.metadata,
    principalUpdatedAt: schema.principals.updatedAt,
  };
  type Joined = {
    id: string;
    email: string;
    displayName: string | null;
    createdAt: Date;
    updatedAt: Date;
    externalId: string | null;
    metadata: unknown;
    principalUpdatedAt: Date;
  };
  const toRow = (r: Joined): ScimUserRow => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    ...scimName(r.metadata),
    externalId: r.externalId,
    active: !hasMarker(r.metadata, "scim_deprovisioned_at"),
    createdAt: r.createdAt,
    updatedAt:
      r.principalUpdatedAt > r.updatedAt ? r.principalUpdatedAt : r.updatedAt,
  });
  // Read with `.innerJoin(schema.users, operatorUserJoin)`, the relations
  // seam, which carries the `kind = 'human'` filter; this adds the fence.
  const orgUsers = () =>
    and(
      eq(schema.principals.orgId, orgId),
      isNull(schema.principals.workspaceId),
      isNull(schema.users.deletedAt),
      notScimDeleted,
    );
  const userFilter = (filter: ScimEqFilter | null) => {
    if (filter === null) return undefined;
    switch (filter.attribute) {
      case "username":
      case "emails.value":
        return eq(schema.users.email, filter.value.toLowerCase());
      case "externalid":
        return eq(schema.principals.idpSubject, filter.value);
      default:
        // `id`: a value that is not a uuid matches nobody rather than failing
        // the cast in Postgres.
        return isScimId(filter.value)
          ? eq(schema.users.id, filter.value)
          : sql`false`;
    }
  };

  const groupRow = {
    id: schema.scimGroups.id,
    displayName: schema.scimGroups.displayName,
    externalId: schema.scimGroups.externalId,
    createdAt: schema.scimGroups.createdAt,
    updatedAt: schema.scimGroups.updatedAt,
  };
  const groupFilter = (filter: ScimEqFilter | null) => {
    if (filter === null) return undefined;
    switch (filter.attribute) {
      case "displayname":
        return eq(schema.scimGroups.displayName, filter.value);
      case "externalid":
        return eq(schema.scimGroups.externalId, filter.value);
      default:
        return isScimId(filter.value)
          ? eq(schema.scimGroups.id, filter.value)
          : sql`false`;
    }
  };

  const store: ScimStore = {
    async verifiedDomains() {
      const rows = await tx
        .select({ domain: schema.ssoProviderTable.domain })
        .from(schema.ssoProviderTable)
        .where(
          and(
            eq(schema.ssoProviderTable.organizationId, orgId),
            eq(schema.ssoProviderTable.domainVerified, true),
          ),
        );
      return rows.map((r) => r.domain.toLowerCase());
    },

    async groupRoleMappings() {
      const rows = await tx
        .select({
          group: schema.ssoGroupRoles.idpGroup,
          role: schema.ssoGroupRoles.role,
        })
        .from(schema.ssoGroupRoles)
        .where(eq(schema.ssoGroupRoles.orgId, orgId));
      return rows.map((r) => ({ group: r.group, role: r.role as SsoMappableRole }));
    },

    async findUser(userId) {
      const [row] = await tx
        .select(userColumns)
        .from(schema.principals)
        .innerJoin(schema.users, operatorUserJoin)
        .where(and(orgUsers(), eq(schema.users.id, userId)))
        .limit(1);
      return row ? toRow(row) : null;
    },

    async findUserByEmail(email) {
      const [row] = await tx
        .select(userColumns)
        .from(schema.principals)
        .innerJoin(schema.users, operatorUserJoin)
        .where(and(orgUsers(), eq(schema.users.email, email.toLowerCase())))
        .limit(1);
      return row ? toRow(row) : null;
    },

    async listUsers(filter, offset, limit) {
      const where = and(orgUsers(), userFilter(filter));
      const [total] = await tx
        .select({ n: count() })
        .from(schema.principals)
        .innerJoin(schema.users, operatorUserJoin)
        .where(where);
      const rows =
        limit === 0
          ? []
          : await tx
              .select(userColumns)
              .from(schema.principals)
              .innerJoin(schema.users, operatorUserJoin)
              .where(where)
              .orderBy(schema.users.createdAt, schema.users.id)
              .offset(offset)
              .limit(limit);
      return { rows: rows.map(toRow), total: Number(total?.n ?? 0) };
    },

    async provisionUser({ email, name, externalId }) {
      const now = new Date();
      const [existing] = await tx
        .select({ id: schema.users.id, emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
        .limit(1);
      let userId = existing?.id;
      if (existing && !existing.emailVerified) {
        // An unverified account on this address may have been registered by
        // someone who does not own the inbox (account pre-hijacking). The
        // identity provider has just vouched for the address on a domain
        // this organization proved it owns, so the address is now verified,
        // and whatever password and sessions the unverified registration
        // left behind are dropped, as account-linking.ts does for a trusted
        // social sign-in. The real owner sets a password through the
        // verified forgot-password flow.
        await tx
          .update(schema.users)
          .set({ emailVerified: true, updatedAt: now })
          .where(eq(schema.users.id, existing.id));
        await tx
          .update(schema.accounts)
          .set({ password: null, updatedAt: now })
          .where(
            and(
              eq(schema.accounts.userId, existing.id),
              eq(schema.accounts.providerId, "credential"),
            ),
          );
        await tx
          .delete(schema.sessions)
          .where(eq(schema.sessions.userId, existing.id));
      }
      if (!userId) {
        // The identity provider vouches for the address and the organization
        // proved it owns the domain, so the email counts as verified, as it
        // does for an SSO sign-in's just-in-time account.
        const [created] = await tx
          .insert(schema.users)
          .values({
            email,
            displayName: name.displayName,
            status: "active",
            emailVerified: true,
          })
          .returning({ id: schema.users.id });
        if (!created) throw new Error("SCIM user insert returned no row");
        userId = created.id;
      }
      const scim = { givenName: name.givenName, familyName: name.familyName };
      const [principal] = await tx
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(principalOf(userId))
        .limit(1);
      if (principal) {
        await tx
          .update(schema.principals)
          .set({
            status: "active",
            idpSubject: externalId,
            displayName: name.displayName ?? email,
            metadata: sql`(${schema.principals.metadata} - 'scim_deprovisioned_at' - 'scim_deleted_at') || ${JSON.stringify({ scim })}::jsonb`,
            updatedAt: now,
          })
          .where(eq(schema.principals.id, principal.id));
      } else {
        await tx.insert(schema.principals).values({
          orgId,
          kind: "human",
          displayName: name.displayName ?? email,
          status: "active",
          parentUserId: userId,
          idpSubject: externalId,
          metadata: { scim },
        });
      }
      return { userId, linked: existing !== undefined };
    },

    async setUserEmail(userId, email) {
      const [other] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.email, email), ne(schema.users.id, userId)))
        .limit(1);
      if (other) {
        throw new ScimError(
          409,
          `Another Oxagen account already uses ${email}`,
          "uniqueness",
        );
      }
      await tx
        .update(schema.users)
        .set({ email, updatedAt: new Date() })
        .where(eq(schema.users.id, userId));
    },

    async setUserName(userId, name: ScimNameInput, { account }) {
      const now = new Date();
      // The account is shared across organizations; the service passes
      // `account` only for an identity this organization owns.
      if (account && name.displayName !== null) {
        await tx
          .update(schema.users)
          .set({ displayName: name.displayName, updatedAt: now })
          .where(eq(schema.users.id, userId));
      }
      await tx
        .update(schema.principals)
        .set({
          ...(name.displayName !== null ? { displayName: name.displayName } : {}),
          metadata: sql`${schema.principals.metadata} || ${JSON.stringify({
            scim: { givenName: name.givenName, familyName: name.familyName },
          })}::jsonb`,
          updatedAt: now,
        })
        .where(principalOf(userId));
    },

    async setExternalId(userId, externalId) {
      await tx
        .update(schema.principals)
        .set({ idpSubject: externalId, updatedAt: new Date() })
        .where(principalOf(userId));
    },

    isOwner: (userId) => isOrgOwner(tx, orgId, userId),

    async deprovision(userId, trigger, { endSessions }) {
      await removeOrgMemberInTx(tx, {
        orgId,
        userId,
        actorId: null,
        trigger,
        endSessions,
        keys: "all",
        refuseOwner: true,
        principalStatus: "suspended",
        summaryEvent: "scim.user_deprovisioned",
        requestId,
      });
      if (trigger === "scim_delete") {
        await tx
          .delete(schema.scimGroupMembers)
          .where(
            and(
              eq(schema.scimGroupMembers.orgId, orgId),
              eq(schema.scimGroupMembers.userId, userId),
            ),
          );
        await tx
          .update(schema.principals)
          .set({
            metadata: sql`${schema.principals.metadata} || ${JSON.stringify({
              scim_deleted_at: new Date().toISOString(),
            })}::jsonb`,
          })
          .where(principalOf(userId));
      }
    },

    async reactivate(userId) {
      await tx
        .update(schema.principals)
        .set({
          status: "active",
          metadata: sql`${schema.principals.metadata} - 'scim_deprovisioned_at'`,
          updatedAt: new Date(),
        })
        .where(principalOf(userId));
    },

    async currentRole(userId) {
      const [row] = await tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(eq(schema.orgUsers.orgId, orgId), eq(schema.orgUsers.userId, userId)),
        )
        .limit(1);
      return row ? row.role.toLowerCase() : null;
    },

    async applyRole(userId, role) {
      await applyMappedOrgRoleInTx(tx, {
        orgId,
        userId,
        role,
        actorId: null,
        trigger: "scim_group_change",
        requestId,
      });
    },

    async groupNamesOf(userId) {
      const rows = await tx
        .select({
          displayName: schema.scimGroups.displayName,
          externalId: schema.scimGroups.externalId,
        })
        .from(schema.scimGroupMembers)
        .innerJoin(
          schema.scimGroups,
          eq(schema.scimGroups.id, schema.scimGroupMembers.groupId),
        )
        .where(
          and(
            eq(schema.scimGroupMembers.orgId, orgId),
            eq(schema.scimGroups.orgId, orgId),
            eq(schema.scimGroupMembers.userId, userId),
          ),
        );
      // Both the name and the external id match a mapping row, so an
      // organization that mapped Entra ID group object ids for SSO sign-in
      // gets the same answer from SCIM.
      return rows.flatMap((r) =>
        r.externalId ? [r.displayName, r.externalId] : [r.displayName],
      );
    },

    async knownUsers(userIds) {
      if (userIds.length === 0) return new Set();
      const rows = await tx
        .select({ userId: schema.principals.parentUserId })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.kind, "human"),
            isNull(schema.principals.workspaceId),
            inArray(schema.principals.parentUserId, [...userIds]),
            notScimDeleted,
          ),
        );
      return new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])));
    },

    async findGroup(groupId) {
      const [row] = await tx
        .select(groupRow)
        .from(schema.scimGroups)
        .where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, groupId)))
        .limit(1);
      return (row as ScimGroupRow | undefined) ?? null;
    },

    async findGroupByName(displayName) {
      const [row] = await tx
        .select(groupRow)
        .from(schema.scimGroups)
        .where(
          and(
            eq(schema.scimGroups.orgId, orgId),
            eq(schema.scimGroups.displayName, displayName),
          ),
        )
        .limit(1);
      return (row as ScimGroupRow | undefined) ?? null;
    },

    async listGroups(filter, offset, limit) {
      const where = and(eq(schema.scimGroups.orgId, orgId), groupFilter(filter));
      const [total] = await tx
        .select({ n: count() })
        .from(schema.scimGroups)
        .where(where);
      const rows =
        limit === 0
          ? []
          : await tx
              .select(groupRow)
              .from(schema.scimGroups)
              .where(where)
              .orderBy(schema.scimGroups.createdAt, schema.scimGroups.id)
              .offset(offset)
              .limit(limit);
      return { rows: rows as ScimGroupRow[], total: Number(total?.n ?? 0) };
    },

    async createGroup({ displayName, externalId }) {
      const [row] = await tx
        .insert(schema.scimGroups)
        .values({ orgId, displayName, externalId })
        .returning(groupRow);
      if (!row) throw new Error("SCIM group insert returned no row");
      return row as ScimGroupRow;
    },

    async updateGroup(groupId, args) {
      await tx
        .update(schema.scimGroups)
        .set({ ...args, updatedAt: new Date() })
        .where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, groupId)));
    },

    async deleteGroup(groupId) {
      // Members go with the group (ON DELETE CASCADE).
      await tx
        .delete(schema.scimGroups)
        .where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, groupId)));
    },

    async groupMembers(groupId) {
      const rows = await tx
        .select({
          userId: schema.scimGroupMembers.userId,
          displayName: schema.users.displayName,
          email: schema.users.email,
        })
        .from(schema.scimGroupMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.scimGroupMembers.userId))
        .where(
          and(
            eq(schema.scimGroupMembers.orgId, orgId),
            eq(schema.scimGroupMembers.groupId, groupId),
          ),
        );
      return rows.map((r) => ({
        userId: r.userId,
        display: r.displayName ?? r.email,
      }));
    },

    async addGroupMembers(groupId, userIds) {
      await tx
        .insert(schema.scimGroupMembers)
        .values(userIds.map((userId) => ({ groupId, orgId, userId })))
        .onConflictDoNothing();
      await store.updateGroup(groupId, {});
    },

    async removeGroupMembers(groupId, userIds) {
      await tx
        .delete(schema.scimGroupMembers)
        .where(
          and(
            eq(schema.scimGroupMembers.orgId, orgId),
            eq(schema.scimGroupMembers.groupId, groupId),
            inArray(schema.scimGroupMembers.userId, [...userIds]),
          ),
        );
      await store.updateGroup(groupId, {});
    },

    async audit(eventType, detail) {
      await emitSecurityEventIn(tx, {
        eventType,
        actorUserId: null,
        orgId,
        workspaceId: null,
        capability: CAPABILITY,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId,
        detail: detail as never,
      });
    },
  };
  return store;
}
