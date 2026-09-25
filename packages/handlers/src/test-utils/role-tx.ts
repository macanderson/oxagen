// A withTenantDb transaction double for the role gate in @oxagen/iam
// (`resolveActingUserId`, `resolveActorOrgRole`, `assertOrgRole`). It answers
// by the table a query reads: an API key's creator, the caller's principal,
// and the role assigned at org scope or at workspace scope, told apart by the
// scope kind the assignment query binds. The gate itself runs for real.
import { schema } from "@oxagen/database";

export type RoleFixture = {
  /** The org-wide role, or null for none. */
  org: string | null;
  /** The role on the call's workspace, or null for none. */
  workspace?: string | null;
  /** The creator an API key resolves to; null for a key with none. */
  keyCreator?: string | null;
};

/** Whether a drizzle SQL tree binds `value` as a parameter. */
function binds(
  node: unknown,
  value: string,
  seen = new Set<unknown>(),
): boolean {
  if (node === value) return true;
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => binds(n, value, seen));
  if ("queryChunks" in node) return binds(node.queryChunks, value, seen);
  if ("value" in node) return binds(node.value, value, seen);
  return false;
}

function rowsFor(
  table: unknown,
  where: unknown,
  roles: RoleFixture,
): unknown[] {
  if (table === schema.apiKeys) {
    return roles.keyCreator ? [{ createdById: roles.keyCreator }] : [];
  }
  if (table === schema.principals) return [{ id: "prn_1" }];
  if (table === schema.principalRoleAssignments) {
    const role = binds(where, "workspace")
      ? (roles.workspace ?? null)
      : roles.org;
    return role === null ? [] : [{ roleName: role }];
  }
  throw new Error("the role gate read a table the double does not answer");
}

/** A transaction double answering the role gate's reads from `roles`. */
export function roleTx(roles: RoleFixture) {
  return {
    select: () => ({
      from: (table: unknown) => {
        let where: unknown;
        const chain = {
          innerJoin: () => chain,
          where: (cond: unknown) => {
            where = cond;
            return chain;
          },
          limit: () => Promise.resolve(rowsFor(table, where, roles)),
        };
        return chain;
      },
    }),
  };
}

/** A `withTenantDb` implementation answering the role gate from `roles`. */
export function roleTenantDb(roles: RoleFixture) {
  return (fn: (tx: unknown) => unknown) => Promise.resolve(fn(roleTx(roles)));
}
