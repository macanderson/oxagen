// audit-exempt: a read of the org's permission model; the writes are create_role, set_role_grants and delete_role, each with its own security event.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  iamRoleList,
  type IamRoleRow,
} from "@oxagen/oxagen/contracts/iam.role.list";
import { PERMISSION_CATALOG } from "@oxagen/oxagen/iam";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { toRoleRow } from "./lib/iam-roles";
import { roleEnforcementOf } from "./lib/org-tier";
import { logger } from "./logger";

/**
 * iam.role.list handler.
 *
 * Reads the org's IAM roles, their capability grants, the catalogue
 * permissions those grants cover, who created each role, and the count of
 * active principal assignments per role — with the permission catalogue and
 * whether the kernel enforces roles for the org's tier (ADR-063). The IAM
 * tables live in the dedicated `iam` Postgres schema and are read through
 * withSystemDb, so tenant isolation is enforced HERE explicitly: every query
 * filters by ctx.orgId. Never relax this — role/grant data is the org's
 * permission model.
 *
 * Role gate (INV-29): org Owner, Admin or Compliance, the roles the contract
 * declares. The kernel's IAM check allows every capability for a
 * non-enterprise organization, so without this a Member could read the role
 * catalogue, its scopes and the enforcement tier through the API and MCP. An
 * API key acts as its creator (resolveActingUserId).
 */
export const iamRoleListHandler: CapabilityHandler<typeof iamRoleList> = async (
  input,
  ctx,
) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(iamRoleList, ctx);
  const { orgId } = ctx;
  const enforcement = await roleEnforcementOf(ctx);

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
        createdAt: schema.roles.createdAt,
        createdById: schema.roles.createdById,
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

    // The origin line: who created each custom role. System roles read as
    // built-in on the page, so their creator (the org's bootstrap actor) is
    // not looked up.
    const creatorIds = [
      ...new Set(
        page
          .filter((r) => !r.isSystemDefault && r.createdById !== null)
          .map((r) => r.createdById as string),
      ),
    ];
    const creatorNames = new Map<string, string>();
    if (creatorIds.length > 0) {
      const userRows = await tx
        .select({
          id: schema.users.id,
          displayName: schema.users.displayName,
          email: schema.users.email,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, creatorIds));
      for (const u of userRows)
        creatorNames.set(u.id, u.displayName ?? u.email);
    }

    const roles: IamRoleRow[] = page.map((r) =>
      toRoleRow(
        { ...r, scopeKind: r.scopeKind as IamRoleRow["scopeKind"] },
        grantsByRole.get(r.id) ?? [],
        counts.get(r.id) ?? 0,
        r.isSystemDefault || r.createdById === null
          ? null
          : (creatorNames.get(r.createdById) ?? null),
      ),
    );

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
    catalog: PERMISSION_CATALOG.map((p) => ({
      id: p.id,
      group: p.group,
      description: p.description,
      capabilities: [...p.capabilities],
    })),
    enforcement,
  };
};
