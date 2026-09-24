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
 * The role write is applyMappedOrgRoleInTx (@oxagen/database/member-lifecycle),
 * which a SCIM group change also runs. A mapped role replaces the person's
 * org-wide role the way change_member_role does. No mapped role runs the
 * shared member removal: org-wide and workspace roles, workspace membership,
 * every key the person created here and each host they enrolled, with an
 * audit row per credential (#3740 item 2). Their sessions stay, because a
 * session is not this organisation's to end.
 */
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { applyMappedOrgRoleInTx } from "@oxagen/database/member-lifecycle";
import type { SsoMappableRole } from "@oxagen/oxagen/contracts/org.sso.shared";
import { orgHasSso } from "./entitlement";
import type { SsoProvisioningStore } from "./provision";

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
      const outcome = await withSystemDb((tx) =>
        applyMappedOrgRoleInTx(tx, {
          orgId,
          userId,
          role,
          actorId: userId,
          trigger: "sso_deny",
        }),
      );
      return outcome.kind === "scim_suspended" ? "scim_suspended" : "applied";
    },
  };
}
