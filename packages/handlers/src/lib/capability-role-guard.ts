// capability-role-guard.ts — the handler-side half of capability authorization.
//
// Why this exists at all. The kernel's IAM gate (packages/iam/src/check-iam.ts)
// returns `tier_gate → allow` when `canAccessACL(tier)` is false, and
// `canAccessACL` is true only for the enterprise tier
// (packages/billing/src/entitlements.ts). For every other organisation the gate
// therefore allows BEFORE `fetchAuthz` runs: no policy is consulted, and a
// contract's `defaultEffect: "deny"` and `defaultRoles` are never read. A
// capability declaring `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`
// was in practice reachable by any member of the org — oxagen#2819.
//
// This guard re-asks the question inside the handler, from the contract's own
// `defaultRoles`, so the answer holds whatever the tier gate decides. It is
// defence in depth and not a replacement: the gate stays exactly where it is,
// and tightening it is a separate product decision with its own blast radius.
//
// Reading the role set from the contract rather than restating it here is the
// point. A hand-copied `{"owner","admin"}` in five handlers is five places to
// drift from the one table the IAM layer reads; this way the handler enforces
// whatever the contract declares, and a contract edit moves both gates at once.
//
// Two guards live here. `assertCallerRole` is the older one: it reads the
// membership columns (`org_users.role`, `workspace_users.role`), waves an API
// key through, and refuses with a plain Error. `assertContractRole` is the one
// new handlers use (#4194): it asks `assertOrgRole` in @oxagen/iam, which
// reads the IAM role assignments the assistant's own gate reads, acts as an
// API key's creator (apps/app/ARCHITECTURE.md §9, 2026-09-15), and refuses
// with `HandlerError { code: "forbidden" }`, which the API maps to 403.

import {
  HandlerError,
  type CapabilityContext,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { schema, withSystemDb } from "@oxagen/database";
import {
  assertOrgRole,
  resolveActingUserId,
  type OrgRoleRequirement,
} from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";

/** The two fields of a contract this guard reads. */
export type RoleGatedCapability = Pick<
  CapabilityDeclaration,
  "name" | "defaultRoles"
>;

/** Role names a contract grants, lowercased for comparison. */
export interface PermittedRoles {
  org: Set<string>;
  workspace: Set<string>;
  /** The declared names, in declaration order, for the error message. */
  orgNames: string[];
  workspaceNames: string[];
}

/**
 * The roles a contract's `defaultRoles` actually grants.
 *
 * Only `"allow"` grants. `"deny"` obviously does not, and `"require_approval"`
 * deliberately does not either: the approval step is read only by the agent
 * tool wrapper (packages/agent/src/runtime/materialize-tools.ts), so on the API
 * and MCP surfaces there is nothing to satisfy. Denying is the fail-closed
 * reading until that step exists on those surfaces (oxagen#2819).
 *
 * Role names are lowercased because `org_users.role` and `workspace_users.role`
 * are written in BOTH casings — lowercase by `organization.create` and the
 * invite-accept path, TitleCase by `workspace.invite.send`'s `mapRole()` and
 * `org.member.role.change`, which writes the IAM role NAME. Both columns' CHECK
 * is `lower(role) IN (...)` for that reason. A case-sensitive compare here
 * would deny a member who was legitimately promoted to Admin through the
 * governed capability.
 */
export function permittedRoles(
  capability: RoleGatedCapability,
): PermittedRoles {
  const orgNames = Object.entries(capability.defaultRoles.org)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
  const workspaceNames = Object.entries(capability.defaultRoles.workspace)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
  return {
    org: new Set(orgNames.map((r) => r.toLowerCase())),
    workspace: new Set(workspaceNames.map((r) => r.toLowerCase())),
    orgNames,
    workspaceNames,
  };
}

function describe(permitted: PermittedRoles): string {
  const parts: string[] = [];
  if (permitted.orgNames.length > 0) {
    parts.push(`org ${permitted.orgNames.join(" or ")}`);
  }
  if (permitted.workspaceNames.length > 0) {
    parts.push(`workspace ${permitted.workspaceNames.join(" or ")}`);
  }
  return parts.join(", or ");
}

/** The caller's membership role in an org, lowercased, or null when absent. */
async function orgRole(orgId: string, userId: string): Promise<string | null> {
  // withSystemDb, not withTenantDb: this read decides whether the caller may
  // act in the scope, so it must not itself depend on that scope being set.
  // `privacy.data.export` reads the same column the same way.
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
  return rows[0]?.role?.toLowerCase() ?? null;
}

/** The caller's membership role in a workspace, lowercased, or null. */
async function workspaceRole(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  return rows[0]?.role?.toLowerCase() ?? null;
}

/**
 * Refuse the call unless the caller holds one of the roles the contract grants.
 *
 * Throws on: no authenticated principal, no `ctx.orgId`, no membership row, or
 * a membership role the contract does not grant. Returns silently otherwise.
 *
 * **An api-key principal is not role-checked here.** It has no `org_users` row
 * to read — its authority is the `scope` column on `auth.api_keys`, granted
 * when the key was minted by an Owner or Admin
 * (`packages/handlers/src/lib/api-key-authz.ts`), and enforced at the auth
 * layer. This matches `org.member.add`, the handler this guard is modelled on.
 * A handler that wants to refuse machine principals outright does so with its
 * own `if (!ctx.userId)` check before calling this — `connection.delete` does,
 * and keeps it.
 */
export async function assertCallerRole(
  capability: RoleGatedCapability,
  ctx: CapabilityContext,
): Promise<void> {
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new Error(
      `Unauthorized: ${capability.name} requires an authenticated principal`,
    );
  }
  // Machine principal: see the docblock. Nothing to read, nothing to compare.
  if (!ctx.userId) return;

  if (!ctx.orgId) {
    throw new Error(`Forbidden: ${capability.name} requires an org scope`);
  }

  const permitted = permittedRoles(capability);
  if (permitted.org.size === 0 && permitted.workspace.size === 0) {
    // A contract that grants no role to anyone cannot be gated on role. Saying
    // so is better than the bare "requires " a formatted empty set produces —
    // the fix is in the contract, not here.
    throw new Error(
      `Forbidden: ${capability.name} grants no role in its contract, so no caller can be authorized by role`,
    );
  }
  const denial = `Forbidden: ${capability.name} requires ${describe(permitted)}`;

  if (permitted.org.size > 0) {
    const role = await orgRole(ctx.orgId, ctx.userId);
    if (role !== null && permitted.org.has(role)) return;
  }

  if (permitted.workspace.size > 0 && ctx.workspaceId) {
    const role = await workspaceRole(ctx.workspaceId, ctx.userId);
    if (role !== null && permitted.workspace.has(role)) return;
  }

  throw new Error(denial);
}

/**
 * The `assertOrgRole` requirement a contract's `defaultRoles` declares: every
 * org role and every workspace role it grants `"allow"`, by IAM role name
 * (`iam.roles.name`), in declaration order. `"require_approval"` grants
 * nothing, for the reason `permittedRoles` gives.
 */
export function contractRoleRequirement(
  capability: RoleGatedCapability,
): OrgRoleRequirement {
  const { orgNames, workspaceNames } = permittedRoles(capability);
  return workspaceNames.length > 0
    ? { org: orgNames, workspace: workspaceNames }
    : { org: orgNames };
}

/**
 * Refuse the call unless the acting user holds a role the contract grants.
 *
 * The acting user is the signed-in user, or the creator of the API key
 * (`resolveActingUserId`), so a key acts with its creator's current roles and
 * no more. The check is `assertOrgRole` over `contractRoleRequirement`: an org
 * role the contract grants passes, and so does a granted workspace role on
 * `ctx.workspaceId`. Anything else is `HandlerError { code: "forbidden" }`,
 * with reason `no_principal` when no user resolves and `org_role_required`
 * otherwise. Returns the role that satisfied the check.
 *
 * Call it first in a handler, before any read of tenant data, so a refused
 * caller learns nothing from the call but the refusal.
 */
export async function assertContractRole(
  capability: RoleGatedCapability,
  ctx: CapabilityContext,
): Promise<string> {
  const required = contractRoleRequirement(capability);
  if (required.org.length === 0 && !required.workspace) {
    // A contract that grants no role cannot be passed by role. The fix is in
    // the contract, so the message names it.
    throw new HandlerError({
      code: "forbidden",
      reason: "org_role_required",
      message: `${capability.name} grants no role in its contract`,
    });
  }
  const actingUserId = await resolveActingUserId(ctx);
  return assertOrgRole({ ...ctx, userId: actingUserId }, required);
}
