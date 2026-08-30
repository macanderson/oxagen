import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  iamRoleList,
  type IamRoleRow,
} from "@oxagen/oxagen/contracts/iam.role.list";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * iam.role.list handler.
 *
 * Reads the org's IAM roles, their capability grants, and the count of active
 * principal assignments per role. The IAM tables live in the dedicated `iam`
 * Postgres schema and are read through withSystemDb, so tenant isolation is
 * enforced HERE explicitly: every query filters by ctx.orgId. Never relax
 * this — role/grant data is the org's permission model.
 *
 * Read-only by design (ship-read-first): role and grant writes remain
 * provisioning-script-only until dedicated write contracts are authored.
 */
export const iamRoleListHandler: CapabilityHandler<typeof iamRoleList> = async (
  input,
  ctx,
) => {
  const { orgId } = ctx;

  const result = await withSystemDb(async (tx) => {
    const roleConds = [eq(schema.roles.orgId, orgId)];
    if (input.scopeKind)
      roleConds.push(eq(schema.roles.scopeKind, input.scopeKind));

    const allRoles = await tx
      .select({
        id: schema.roles.id,
        publicId: schema.roles.publicId,
        name: schema.roles.name,
        description: schema.roles.description,
        scopeKind: schema.roles.scopeKind,
        isSystemDefault: schema.roles.isSystemDefault,
        version: schema.roles.version,
      })
      .from(schema.roles)
      .where(and(...roleConds));

    // Stable catalog order: system defaults first, then alphabetical.
    allRoles.sort((a, b) => {
      if (a.isSystemDefault !== b.isSystemDefault)
        return a.isSystemDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const total = allRoles.length;
    const page = allRoles.slice(input.offset, input.offset + input.limit);
    const pageIds = page.map((r) => r.id);

    // Active assignment counts: non-deleted and not expired.
    const counts = new Map<string, number>();
    if (pageIds.length > 0) {
      const now = new Date();
      const countRows = await tx
        .select({
          roleId: schema.principalRoleAssignments.roleId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.orgId, orgId),
            inArray(schema.principalRoleAssignments.roleId, pageIds),
            isNull(schema.principalRoleAssignments.deletedAt),
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, now),
            ),
          ),
        )
        .groupBy(schema.principalRoleAssignments.roleId);
      for (const row of countRows) counts.set(row.roleId, row.count);
    }

    // Grants per role (skipped when includeGrants=false — the catalog table
    // only needs counts; the drawer asks again with grants on).
    const grantsByRole = new Map<string, IamRoleRow["grants"]>();
    if (input.includeGrants && pageIds.length > 0) {
      const grantRows = await tx
        .select({
          roleId: schema.roleGrants.roleId,
          capabilityId: schema.roleGrants.capabilityId,
          effect: schema.roleGrants.effect,
        })
        .from(schema.roleGrants)
        .where(
          and(
            eq(schema.roleGrants.orgId, orgId),
            inArray(schema.roleGrants.roleId, pageIds),
          ),
        );
      for (const g of grantRows) {
        const effect = g.effect as IamRoleRow["grants"][number]["effect"];
        const list = grantsByRole.get(g.roleId) ?? [];
        list.push({ capability: g.capabilityId, effect });
        grantsByRole.set(g.roleId, list);
      }
      for (const list of grantsByRole.values()) {
        list.sort((a, b) => a.capability.localeCompare(b.capability));
      }
    }

    const roles: IamRoleRow[] = page.map((r) => ({
      id: r.publicId,
      name: r.name,
      description: r.description,
      scopeKind: r.scopeKind as IamRoleRow["scopeKind"],
      isSystemDefault: r.isSystemDefault,
      version: r.version,
      memberCount: counts.get(r.id) ?? 0,
      grants: grantsByRole.get(r.id) ?? [],
    }));

    return { roles, total };
  });

  logger.info(
    { orgId, returned: result.roles.length, total: result.total },
    "iam.role.list: roles read",
  );

  return {
    roles: result.roles,
    total: result.total,
    hasMore: result.total > input.offset + input.limit,
    limit: input.limit,
    offset: input.offset,
  };
};
