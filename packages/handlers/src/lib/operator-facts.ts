// The person behind a principal public id, for the rows that name an operator.
//
// One read for a page of ids: the principal's user record for the name, the
// email and the avatar, and the role assignment in the caller's scope for the
// role. A workspace-scoped read prefers the workspace assignment and falls
// back to the org-wide one; an org-scoped read takes the org-wide one only.
// A principal that is not a person (an agent, a service) has no user record
// and answers with nulls, never with a made-up name.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { operatorUserJoin, schema, withTenantDb } from "@oxagen/database";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";

export type OperatorScope = { orgId: string; workspaceId?: string | null };

export type ReadOperatorFacts = (
  scope: OperatorScope,
  publicIds: readonly string[],
) => Promise<Map<string, OperatorFacts>>;

const blankToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value;

export const readOperatorFacts: ReadOperatorFacts = async (
  scope,
  publicIds,
) => {
  const ids = [...new Set(publicIds)];
  const facts = new Map<string, OperatorFacts>();
  if (ids.length === 0) return facts;
  const workspaceId = scope.workspaceId ?? null;
  const [people, roles] = await withTenantDb((tx) =>
    Promise.all([
      tx
        .select({
          id: schema.principals.publicId,
          name: schema.users.displayName,
          email: schema.users.email,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.principals)
        .leftJoin(schema.users, operatorUserJoin)
        .where(
          and(
            eq(schema.principals.orgId, scope.orgId),
            inArray(schema.principals.publicId, ids),
          ),
        ),
      tx
        .select({
          id: schema.principals.publicId,
          role: schema.roles.name,
          workspaceId: schema.principalRoleAssignments.workspaceId,
        })
        .from(schema.principalRoleAssignments)
        .innerJoin(
          schema.roles,
          eq(schema.roles.id, schema.principalRoleAssignments.roleId),
        )
        .innerJoin(
          schema.principals,
          eq(schema.principals.id, schema.principalRoleAssignments.principalId),
        )
        .where(
          and(
            eq(schema.principalRoleAssignments.orgId, scope.orgId),
            inArray(schema.principals.publicId, ids),
            workspaceId === null
              ? isNull(schema.principalRoleAssignments.workspaceId)
              : or(
                  eq(schema.principalRoleAssignments.workspaceId, workspaceId),
                  isNull(schema.principalRoleAssignments.workspaceId),
                ),
          ),
        ),
    ]),
  );
  for (const person of people) {
    facts.set(person.id, {
      id: person.id,
      name: blankToNull(person.name),
      email: blankToNull(person.email),
      avatarUrl: blankToNull(person.avatarUrl),
      role: null,
    });
  }
  // The workspace assignment wins over the org-wide one; either fills a gap.
  for (const row of roles) {
    const current = facts.get(row.id);
    if (current === undefined) continue;
    const scoped = row.workspaceId !== null;
    if (current.role === null || scoped) {
      facts.set(row.id, { ...current, role: blankToNull(row.role) });
    }
  }
  return facts;
};

/** For a test or a surface that has no store: nobody is known. */
export const noOperatorFacts: ReadOperatorFacts = () =>
  Promise.resolve(new Map<string, OperatorFacts>());
