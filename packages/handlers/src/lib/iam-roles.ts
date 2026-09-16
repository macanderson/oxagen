// iam-roles.ts — the store the role editor writes through (ADR-063).
//
// `create_role`, `set_role_grants` and `delete_role` run their whole check
// and write inside one `withTenantDb` transaction through this interface, so
// the delegation ceiling and the grant replacement are one atomic, RLS-scoped
// unit and the handlers are tested against a fake store. `iam.roles` and
// `iam.role_grants` carry the org_only RLS policy; every read here still
// pins `org_id`, as the list handler does.

import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import {
  postgresDelegationCeilingReads,
  type DelegationCeilingReads,
} from "@oxagen/iam";
import type { IamRoleRow } from "@oxagen/oxagen/contracts/iam.role.list";
import { permissionsHeldBy } from "@oxagen/oxagen/iam";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { AGENT_ROLE_NAMES } from "./agent-role-defaults";

export interface RoleRecord {
  /** Internal uuid. */
  readonly id: string;
  readonly publicId: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopeKind: "org" | "workspace";
  readonly isSystemDefault: boolean;
  readonly version: string;
  readonly createdAt: Date;
  readonly createdByUserId: string | null;
}

export interface RoleGrantRecord {
  readonly capability: string;
  readonly effect: "allow" | "deny" | "require_approval";
}

export interface RoleStore {
  readonly ceiling: DelegationCeilingReads;
  roleByPublicId(orgId: string, publicId: string): Promise<RoleRecord | null>;
  /** Throws the driver's unique violation for a name taken in the same scope kind. */
  insertRole(row: {
    orgId: string;
    name: string;
    scopeKind: "org" | "workspace";
    description: string | null;
    createdByUserId: string;
  }): Promise<RoleRecord>;
  /** Every grant of the role goes; one `allow` per capability is written. */
  replaceGrants(
    orgId: string,
    roleId: string,
    capabilityIds: readonly string[],
    actorUserId: string,
  ): Promise<void>;
  /**
   * Non-deleted, unexpired assignments holding the role, across the WHOLE
   * organization — every workspace of it and its org-wide assignments alike.
   */
  activeAssignmentCount(orgId: string, roleId: string): Promise<number>;
  /** The role's grants and the role. */
  deleteRole(orgId: string, roleId: string): Promise<void>;
  /** Display name of a user, for the row's origin line. */
  userName(userId: string): Promise<string | null>;
}

const agentSystemRoleNames: ReadonlySet<string> = new Set(AGENT_ROLE_NAMES);

/**
 * Who a role is for: the seeded membership roles are human; the seeded agent
 * roles and every custom role are agent roles, which only
 * `assign_agent_role` binds (packages/agent/src/handlers/agent.role.assign.ts).
 */
export function roleKindOf(
  role: Pick<RoleRecord, "isSystemDefault" | "name">,
): IamRoleRow["kind"] {
  if (!role.isSystemDefault) return "agent";
  return agentSystemRoleNames.has(role.name) ? "agent" : "human";
}

/** The contract row for a role, given its grants and assignment count. */
export function toRoleRow(
  role: RoleRecord,
  grants: readonly RoleGrantRecord[],
  memberCount: number,
  createdBy: string | null,
): IamRoleRow {
  const allowed = new Set(
    grants.filter((g) => g.effect === "allow").map((g) => g.capability),
  );
  return {
    id: role.publicId,
    name: role.name,
    description: role.description,
    scopeKind: role.scopeKind,
    kind: roleKindOf(role),
    isSystemDefault: role.isSystemDefault,
    version: role.version,
    memberCount,
    grants: [...grants].sort((a, b) =>
      a.capability.localeCompare(b.capability),
    ),
    permissions: permissionsHeldBy(allowed),
    createdAt: role.createdAt.toISOString(),
    createdBy,
  };
}

const ROLE_COLUMNS = {
  id: schema.roles.id,
  publicId: schema.roles.publicId,
  name: schema.roles.name,
  description: schema.roles.description,
  scopeKind: schema.roles.scopeKind,
  isSystemDefault: schema.roles.isSystemDefault,
  version: schema.roles.version,
  createdAt: schema.roles.createdAt,
  createdByUserId: schema.roles.createdByUserId,
};

function asRecord(row: {
  id: string;
  publicId: string;
  name: string;
  description: string | null;
  scopeKind: string;
  isSystemDefault: boolean;
  version: string;
  createdAt: Date;
  createdByUserId: string | null;
}): RoleRecord {
  return { ...row, scopeKind: row.scopeKind as RoleRecord["scopeKind"] };
}

export function postgresRoleStore(tx: Tx): RoleStore {
  return {
    ceiling: postgresDelegationCeilingReads(tx),
    async roleByPublicId(orgId, publicId) {
      const [row] = await tx
        .select(ROLE_COLUMNS)
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.orgId, orgId),
            eq(schema.roles.publicId, publicId),
          ),
        )
        .limit(1);
      return row ? asRecord(row) : null;
    },
    async insertRole(row) {
      const [inserted] = await tx
        .insert(schema.roles)
        .values({
          orgId: row.orgId,
          name: row.name,
          scopeKind: row.scopeKind,
          description: row.description,
          isSystemDefault: false,
          createdByUserId: row.createdByUserId,
          updatedByUserId: row.createdByUserId,
        })
        .returning(ROLE_COLUMNS);
      if (!inserted) throw new Error("iam.roles insert returned no row");
      return asRecord(inserted);
    },
    async replaceGrants(orgId, roleId, capabilityIds, actorUserId) {
      await tx
        .delete(schema.roleGrants)
        .where(
          and(
            eq(schema.roleGrants.orgId, orgId),
            eq(schema.roleGrants.roleId, roleId),
          ),
        );
      if (capabilityIds.length > 0) {
        await tx.insert(schema.roleGrants).values(
          capabilityIds.map((capabilityId) => ({
            orgId,
            roleId,
            capabilityId,
            effect: "allow" as const,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })),
        );
      }
      await tx
        .update(schema.roles)
        .set({ updatedAt: new Date(), updatedByUserId: actorUserId })
        .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.id, roleId)));
    },
    async activeAssignmentCount(orgId, roleId) {
      // NOT on `tx`. `iam.principal_role_assignments` is `workspace_nullable`
      // (tenant-policy.manifest.ts), so its `tenant_isolation` USING clause
      // shows a row only when `workspace_id IS NULL` or it equals
      // `app.current_workspace_id`. Every assignment scoped to a REAL
      // workspace is therefore invisible under any other scope — and under the
      // org-only sentinel (ADR-068), which names no workspace, ALL of them
      // are. `delete_role` is a check-then-act on this number: it read zero,
      // deleted the role and its grants, and left the live assignment rows
      // pointing at a role that no longer exists. Nothing raised, because RLS
      // hides rather than refuses.
      //
      // "Does anyone in this org hold this role?" is an org-wide question, so
      // it is answered the way `list_iam_roles` answers the same one: through
      // withSystemDb with the org fence written out here. Never relax the
      // `org_id` predicate below — it is the whole of the isolation on this
      // read.
      const [row] = await withSystemDb((sys) =>
        sys
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.principalRoleAssignments)
          .where(
            and(
              eq(schema.principalRoleAssignments.orgId, orgId),
              eq(schema.principalRoleAssignments.roleId, roleId),
              isNull(schema.principalRoleAssignments.deletedAt),
              or(
                isNull(schema.principalRoleAssignments.expiresAt),
                gt(schema.principalRoleAssignments.expiresAt, new Date()),
              ),
            ),
          ),
      );
      return row?.count ?? 0;
    },
    async deleteRole(orgId, roleId) {
      await tx
        .delete(schema.roleGrants)
        .where(
          and(
            eq(schema.roleGrants.orgId, orgId),
            eq(schema.roleGrants.roleId, roleId),
          ),
        );
      await tx
        .delete(schema.roles)
        .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.id, roleId)));
    },
    async userName(userId) {
      const [row] = await tx
        .select({
          displayName: schema.users.displayName,
          email: schema.users.email,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row ? (row.displayName ?? row.email) : null;
    },
  };
}

/** One transaction in the caller's tenant scope, the store bound to it. */
export function withRoleStore<T>(fn: (store: RoleStore) => Promise<T>) {
  return withTenantDb((tx) => fn(postgresRoleStore(tx)));
}
