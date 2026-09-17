/**
 * scopes.ts — shape the consent page's org × workspace rows into the picker
 * model. Pure so the grouping rules can be tested without a database.
 */
import type { OrgOption } from "./consent-form";

/** One row of the consent page's membership query (see page.tsx). */
export interface CliAuthScopeRow {
  orgId: string;
  orgSlug: string;
  orgName: string;
  /** Null when the org has no workspaces (LEFT JOIN). */
  workspaceId: string | null;
  workspaceSlug: string | null;
  workspaceName: string | null;
  /** The user's workspace_users row id; null when they are not a member. */
  membershipId: string | null;
}

/**
 * Group rows into orgs with the workspaces the user may authorize against.
 *
 * - Every org appears once, in row order, even with zero eligible workspaces
 *   — the form then says "No workspaces available" rather than hiding the org.
 * - A workspace is listed only when the user is a member of it, because the
 *   approve action asserts that membership and would reject anything else.
 * - Duplicate workspace rows (a user with more than one org_users row) collapse.
 */
export function groupCliAuthScopes(rows: CliAuthScopeRow[]): OrgOption[] {
  const orgs = new Map<string, OrgOption>();
  for (const row of rows) {
    let org = orgs.get(row.orgId);
    if (!org) {
      org = {
        id: row.orgId,
        slug: row.orgSlug,
        name: row.orgName,
        workspaces: [],
      };
      orgs.set(row.orgId, org);
    }
    if (
      row.workspaceId === null ||
      row.workspaceSlug === null ||
      row.workspaceName === null ||
      row.membershipId === null
    ) {
      continue;
    }
    if (org.workspaces.some((w) => w.id === row.workspaceId)) continue;
    org.workspaces.push({
      id: row.workspaceId,
      slug: row.workspaceSlug,
      name: row.workspaceName,
    });
  }
  return Array.from(orgs.values());
}
