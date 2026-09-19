// The one place that reads a person's org membership role, because the column
// it reads is not what anyone expects it to be.
//
// `org_users.role` holds the MEMBERSHIP role, not the capitalized
// `SystemOrgRole` ("Owner") the IAM `defaultRoles` layer uses. They are
// different concepts, and the column is written in both casings: lowercase by
// organization.create and the invite-accept path, TitleCase by
// workspace.invite.send's mapRole() and org.member.role.change. The column's
// CHECK is `lower(role) IN (...)`, so both are valid rows and a case-sensitive
// compare denies a legitimately promoted owner.
//
// That gotcha was written out twice, in privacy.data.erase and
// privacy.data.export, and a third copy was about to be added. One copy that
// every caller shares is the only version of this that stays true.
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

/**
 * This person's role in this organization, lowercased, or null when they hold
 * no membership at all.
 *
 * Null and "member" are different answers and callers must treat them so: a
 * person removed from the org is not the same as one demoted inside it, even
 * where both are refused.
 */
export async function orgMembershipRole(
  orgId: string,
  userId: string,
): Promise<string | null> {
  const rows = await withSystemDb((tx) =>
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
  const role = rows[0]?.role;
  return role ? role.toLowerCase() : null;
}

/** Whether this lowercased role may act on the organization's own data. */
export function isOrgAdministrator(role: string | null): boolean {
  return role === "owner" || role === "admin";
}
