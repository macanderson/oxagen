// audit-exempt: internal IAM-bootstrap helper, not a directly-invoked capability handler. It runs inside organization.create / workspace.create / org.member.invite.accept transactions, each of which already emits its own security event (organization.created / workspace.created / org.role_changed). Emitting here would double-count.
// iam-provision.ts — IAM bootstrapping helpers for org/member creation (OXA-1524).
//
// Two exported helpers, both idempotent (safe to re-run):
//
//   bootstrapOrgIAM({ orgId, ownerUserId, actorUserId, tx? })
//     Upserts the 7 system roles for the org, creates the owner's principal,
//     assigns them the org "Owner" role, and seeds all role_grants from every
//     capability's defaultRoles declaration. Result: the owner resolves "allow"
//     on every Owner-allowed capability.
//
//   provisionMemberPrincipal({ orgId, userId, actorUserId, tx? })
//     Upserts a least-privilege human principal for a new org member with NO
//     role assignment. They are denied everything until explicitly granted.
//
// Deterministic public_id generation:
//   roles:       rol_<sha256(orgId:scopeKind:name)[:22]>
//   role_grants: rlg_<sha256(roleId:capabilityId)[:24]>
//
// Both match the seed-iam-defaults.ts logic so re-running the CLI seed after
// provisioning is a no-op.

import { createHash } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { listCapabilities } from "@oxagen/oxagen";
import { ORG_OWNER_ROLE_NAME } from "@oxagen/oxagen/iam";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

// Callers may pass the active Drizzle transaction handle to run inside an
// existing transaction. When no tx is supplied the function opens a new
// system-bypass transaction via withSystemDb.
// Re-export the Tx alias so callers can type the optional param correctly.
export type { Tx as DbOrTx };

// System role definitions. Mirrored from seed-iam-defaults.ts. The Owner name is
// sourced from the resolver's ORG_OWNER_ROLE_NAME so the seeded role name can
// never drift from the super-user check in resolve.ts (rule 7.5).
const ORG_ROLES = [
  ORG_OWNER_ROLE_NAME,
  "Admin",
  "Compliance",
  "Billing",
] as const;
const WORKSPACE_ROLES = ["Owner", "Member", "Viewer"] as const;

type OrgRoleName = (typeof ORG_ROLES)[number];
type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];
type Effect = "allow" | "deny" | "require_approval";

// ── Deterministic ID helpers ──────────────────────────────────────────────────

/** rol_<sha256(orgId:scopeKind:name)[:22]> */
function makeRolePublicId(
  orgId: string,
  scopeKind: "org" | "workspace",
  name: string,
): string {
  const digest = createHash("sha256")
    .update(`${orgId}:${scopeKind}:${name}`)
    .digest("hex")
    .slice(0, 22);
  return `rol_${digest}`;
}

/** rlg_<sha256(roleId:capabilityId)[:24]> — matches seed-iam-defaults.ts */
function makeRoleGrantPublicId(roleId: string, capabilityId: string): string {
  const digest = createHash("sha256")
    .update(`${roleId}:${capabilityId}`)
    .digest("hex")
    .slice(0, 24);
  return `rlg_${digest}`;
}

// ── bootstrapOrgIAM ───────────────────────────────────────────────────────────

export interface BootstrapOrgIAMArgs {
  orgId: string;
  ownerUserId: string;
  actorUserId: string;
  /** Pass the active Drizzle transaction to run inside the org-create tx. */
  tx?: Tx;
}

/**
 * Bootstrap full IAM state for a newly created org:
 *   (a) upsert the 7 system roles (4 org-level + 3 workspace-level) with
 *       deterministic public_ids so re-runs are idempotent.
 *   (b) upsert the owner's principal (kind:"human", parentUserId:ownerUserId).
 *   (c) assign the owner the org "Owner" role via principal_role_assignments.
 *   (d) seed role_grants for all roles from every capability's defaultRoles.
 *
 * Idempotent: safe to call multiple times; all operations use conflict-free
 * or select-then-insert patterns.
 */
export async function bootstrapOrgIAM(
  args: BootstrapOrgIAMArgs,
): Promise<void> {
  const { orgId, ownerUserId, actorUserId, tx } = args;
  // tenancy: system bypass via withSystemDb (bootstrap — always called with an
  // explicit tx from the org/workspace creation transaction in normal kernel
  // flow; the withSystemDb fallback covers direct seeding calls outside the
  // kernel scope where no ALS scope exists) — OXA-1515
  if (tx) {
    return bootstrapOrgIAMWithTx(orgId, ownerUserId, actorUserId, tx);
  }
  return withSystemDb((sysTx) =>
    bootstrapOrgIAMWithTx(orgId, ownerUserId, actorUserId, sysTx),
  );
}

async function bootstrapOrgIAMWithTx(
  orgId: string,
  ownerUserId: string,
  actorUserId: string,
  d: Tx,
): Promise<void> {
  // ── (a) Upsert 7 system roles ─────────────────────────────────────────────
  // Build the full set: 4 org-level + 3 workspace-level.
  type RoleSpec = { scopeKind: "org" | "workspace"; name: string };
  const roleSpecs: RoleSpec[] = [
    ...ORG_ROLES.map((name) => ({ scopeKind: "org" as const, name })),
    ...WORKSPACE_ROLES.map((name) => ({
      scopeKind: "workspace" as const,
      name,
    })),
  ];

  // Map: "<scopeKind>:<name>" → internal UUID (populated after upserts).
  const roleIdMap = new Map<string, string>();

  for (const spec of roleSpecs) {
    const publicId = makeRolePublicId(orgId, spec.scopeKind, spec.name);

    // Try insert first; on conflict (public_id unique) fall through to select.
    const existing = await d
      .select({ id: schema.roles.id, publicId: schema.roles.publicId })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, orgId),
          eq(schema.roles.scopeKind, spec.scopeKind),
          eq(schema.roles.name, spec.name),
        ),
      )
      .limit(1);

    let roleId: string;
    if (existing[0]) {
      roleId = existing[0].id;
    } else {
      const [inserted] = await d
        .insert(schema.roles)
        .values({
          publicId,
          orgId,
          scopeKind: spec.scopeKind,
          name: spec.name,
          isSystemDefault: true,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.roles.id });

      if (inserted) {
        roleId = inserted.id;
      } else {
        // Another concurrent insert won; re-select.
        const [reselected] = await d
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(
            and(
              eq(schema.roles.orgId, orgId),
              eq(schema.roles.scopeKind, spec.scopeKind),
              eq(schema.roles.name, spec.name),
            ),
          )
          .limit(1);
        if (!reselected) {
          throw new Error(
            `[iam-provision] Failed to upsert role ${spec.scopeKind}:${spec.name} for org ${orgId}`,
          );
        }
        roleId = reselected.id;
      }
    }

    roleIdMap.set(`${spec.scopeKind}:${spec.name}`, roleId);
  }

  logger.info(
    { orgId, roleCount: roleIdMap.size },
    "iam-provision: system roles upserted",
  );

  // ── (b) Upsert owner principal ────────────────────────────────────────────
  // Fetch the user's display name from auth.users.
  const [userRow] = await d
    .select({
      displayName: schema.users.displayName,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ownerUserId))
    .limit(1);

  const displayName = userRow?.displayName ?? userRow?.email ?? ownerUserId;

  // Idempotent: select-then-insert on (orgId, parentUserId, kind='human').
  const existingPrincipal = await d
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, ownerUserId),
        eq(schema.principals.kind, "human"),
      ),
    )
    .limit(1);

  let principalId: string;

  if (existingPrincipal[0]) {
    principalId = existingPrincipal[0].id;
    logger.debug(
      { orgId, principalId },
      "iam-provision: owner principal already exists",
    );
  } else {
    const [newPrincipal] = await d
      .insert(schema.principals)
      .values({
        orgId,
        kind: "human",
        displayName,
        status: "active",
        parentUserId: ownerUserId,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.principals.id });

    if (newPrincipal) {
      principalId = newPrincipal.id;
    } else {
      // Lost race — re-select.
      const [reselected] = await d
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.parentUserId, ownerUserId),
            eq(schema.principals.kind, "human"),
          ),
        )
        .limit(1);
      if (!reselected) {
        throw new Error(
          `[iam-provision] Failed to upsert owner principal for org ${orgId}`,
        );
      }
      principalId = reselected.id;
    }
    logger.info(
      { orgId, principalId },
      "iam-provision: owner principal created",
    );
  }

  // ── (c) Assign owner the org "Owner" role ─────────────────────────────────
  const ownerRoleId = roleIdMap.get(`org:${ORG_OWNER_ROLE_NAME}`);
  if (!ownerRoleId) {
    throw new Error(
      `[iam-provision] org:Owner role not found in roleIdMap for org ${orgId}`,
    );
  }

  // The partial unique index covers (principalId, roleId, orgId) WHERE workspaceId IS NULL.
  // Select-then-insert: if the PRA row exists, skip.
  const existingPra = await d
    .select({ id: schema.principalRoleAssignments.id })
    .from(schema.principalRoleAssignments)
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalId),
        eq(schema.principalRoleAssignments.roleId, ownerRoleId),
        eq(schema.principalRoleAssignments.orgId, orgId),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    )
    .limit(1);

  if (!existingPra[0]) {
    await d
      .insert(schema.principalRoleAssignments)
      .values({
        principalId,
        roleId: ownerRoleId,
        orgId,
        assignedBy: actorUserId,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .onConflictDoNothing();
    logger.info(
      { orgId, principalId, ownerRoleId },
      "iam-provision: owner role assignment created",
    );
  }

  // ── (d) Seed role_grants from capability defaultRoles ────────────────────
  const capabilities = listCapabilities();

  for (const cap of capabilities) {
    if (!cap.defaultRoles) continue;
    const { org, workspace } = cap.defaultRoles;

    if (org) {
      for (const roleName of ORG_ROLES) {
        const effect = org[roleName as OrgRoleName] as Effect | undefined;
        if (!effect) continue;
        const roleId = roleIdMap.get(`org:${roleName}`);
        if (!roleId) continue;
        const publicId = makeRoleGrantPublicId(roleId, cap.name);
        await d
          .insert(schema.roleGrants)
          .values({
            publicId,
            orgId,
            roleId,
            capabilityId: cap.name,
            effect,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .onConflictDoNothing();
      }
    }

    if (workspace) {
      for (const roleName of WORKSPACE_ROLES) {
        const effect = workspace[roleName as WorkspaceRoleName] as
          | Effect
          | undefined;
        if (!effect) continue;
        const roleId = roleIdMap.get(`workspace:${roleName}`);
        if (!roleId) continue;
        const publicId = makeRoleGrantPublicId(roleId, cap.name);
        await d
          .insert(schema.roleGrants)
          .values({
            publicId,
            orgId,
            roleId,
            capabilityId: cap.name,
            effect,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .onConflictDoNothing();
      }
    }
  }

  logger.info(
    { orgId, capabilityCount: capabilities.length },
    "iam-provision: role_grants seeded from capability defaultRoles",
  );
}

// ── provisionMemberPrincipal ──────────────────────────────────────────────────

export interface ProvisionMemberPrincipalArgs {
  orgId: string;
  userId: string;
  actorUserId: string;
  /** Pass the active Drizzle transaction to run atomically. */
  tx?: Tx;
}

/**
 * Upsert a least-privilege human principal for a new org member.
 * NO role assignment is created — the member is denied everything until
 * explicitly granted. Idempotent: safe to call on existing members.
 *
 * Returns the principal's internal UUID.
 */
export async function provisionMemberPrincipal(
  args: ProvisionMemberPrincipalArgs,
): Promise<string> {
  const { orgId, userId, actorUserId, tx } = args;
  // tenancy: system bypass via withSystemDb (always called with an explicit tx
  // from the invite-accept transaction in normal kernel flow; the withSystemDb
  // fallback covers direct seeding calls outside the kernel scope) — OXA-1515
  if (tx) {
    return provisionMemberPrincipalWithTx(orgId, userId, actorUserId, tx);
  }
  return withSystemDb((sysTx) =>
    provisionMemberPrincipalWithTx(orgId, userId, actorUserId, sysTx),
  );
}

async function provisionMemberPrincipalWithTx(
  orgId: string,
  userId: string,
  actorUserId: string,
  d: Tx,
): Promise<string> {
  // Check if principal already exists.
  const existing = await d
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    logger.debug(
      { orgId, userId },
      "iam-provision: member principal already exists",
    );
    return existing[0].id;
  }

  // Fetch user display name.
  const [userRow] = await d
    .select({
      displayName: schema.users.displayName,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const displayName = userRow?.displayName ?? userRow?.email ?? userId;

  const [inserted] = await d
    .insert(schema.principals)
    .values({
      orgId,
      kind: "human",
      displayName,
      status: "active",
      parentUserId: userId,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.principals.id });

  if (inserted) {
    logger.info(
      { orgId, userId, principalId: inserted.id },
      "iam-provision: member principal created",
    );
    return inserted.id;
  }

  // Lost race — re-select.
  const [reselected] = await d
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
      ),
    )
    .limit(1);

  if (!reselected) {
    throw new Error(
      `[iam-provision] Failed to upsert member principal for org ${orgId}, user ${userId}`,
    );
  }

  return reselected.id;
}
