// fetch-authz.ts — fetch IAM authorization data from Postgres.
//
// Reads the IAM tables (principals, roles, role_grants,
// principal_role_assignments) for a given principal/scope, so the pure
// resolver can decide without any I/O. It returns EMPTY `grants` and
// `policies` collections: those two tables no longer exist (see the note above
// the Promise.all in _fetchAuthz), so resolver rules 1–6 never fire on this
// path and the decision is always made by rule 7, 7.5, or 8. The one exception
// is denyAuthz() below, which SYNTHESIZES a policy to trip rule 2 on purpose.
//
// FAIL-CLOSED ON MISSING MIGRATION: if the IAM tables do not exist yet
// (Postgres error 42P01 — "relation does not exist"), this is "IAM
// enforcement is silently disabled" — a critical incident, not a benign dev
// convenience. It is logged LOUDLY at error level (not warn) and the caller
// gets a synthetic fail-closed DENY (see denyAuthz below), never EMPTY_AUTHZ.
// EMPTY_AUTHZ would let the resolver fall through to rule 8 (each contract's
// defaultEffect) — for any capability whose defaultEffect is "allow" that is
// an unnoticed IAM bypass in prod. Every caller, human session or API key,
// must fail closed the same way. Run `pnpm db:migrate` to apply the IAM
// foundation migration and clear the alert.
//
// A PURPOSE-SCOPED KEY AND resolveOperatorUserId
// (`packages/handlers/src/lib/api-key-authz.ts`): the two answer DIFFERENT
// questions and, read past each other, used to sound like they disagreed
// (#3151). This module's `_fetchAuthz` still resolves a purpose-scoped key
// (a Tacho host, its gateway, a Stella telemetry install) to its CREATOR's
// role grants. That is deliberate and unchanged, and it is what lets a
// machine key pass the full resolver on an enterprise org at all (rule 7).
// `resolveOperatorUserId` answers a narrower question, "did a PERSON
// request this operator action (mint, revoke, rotate a key or enrollment)?",
// and a purpose-scoped key never does, because inheriting a role grant is
// not the same act as a person presenting a request. Neither function is
// the security boundary for what a machine key may invoke at all: that is
// `machineKeyDenial` (`packages/iam/src/machine-key-scope.ts`), which runs
// UNCONDITIONALLY before this module is ever reached and decides the
// question by the key's purpose, never by whose role grants it would
// inherit. What THIS module changed to close the gap: `apiKeyPurpose` on
// `AuthzData` lets `checkIAM` tell a machine-bound key's calls apart from a
// person's for EVIDENCE. The audit row for a call a purpose-scoped key made
// records the credential, never the creator it borrowed role grants from.
// A purpose-scoped key still never "acts for a person" in
// `resolveOperatorUserId`'s sense; this module's return value now says so
// too, on every path that matters, rather than only in the handlers that
// call `resolveOperatorUserId` directly.

import { withOrgDb } from "@oxagen/database";
import { eq, and, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type { Grant, Role, RoleGrant, Policy } from "@oxagen/oxagen/iam";
import { type ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

export interface AuthzData {
  principal: ResolvedPrincipal | null;
  grants: readonly Grant[];
  roles: readonly Role[];
  roleGrants: readonly RoleGrant[];
  policies: readonly Policy[];
  /**
   * The `scope.purpose` string on the API key this request authenticated
   * with, or null when the request carried no API key, the key names no
   * purpose (a plain org key), or the key could not be read (deny/empty
   * paths, where `principal` already carries a synthetic, non-human id and
   * this field is not consulted).
   *
   * This is what lets `checkIAM` answer a question `principal` alone cannot:
   * "was the human identity above INHERITED from a purpose-scoped key's
   * creator, or did a person actually present this request?" See the
   * `resolveOperatorUserId` / `fetchAuthz` reconciliation note above for why
   * that distinction exists and where each caller draws the line.
   */
  apiKeyPurpose: string | null;
}

const EMPTY_AUTHZ: AuthzData = {
  principal: null,
  grants: [],
  roles: [],
  roleGrants: [],
  policies: [],
  apiKeyPurpose: null,
};

/**
 * Sentinel principal id used for a synthetic fail-closed deny — either an
 * API-key caller we cannot yet resolve to a real service principal, or ANY
 * caller when the IAM tables themselves are missing (42P01).
 * Distinct from the all-zero principal the kernel substitutes so denials are
 * traceable.
 */
const UNRESOLVED_SERVICE_PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000ff";

/**
 * Build a fail-closed AuthzData: a synthetic org-enforced DENY policy for the
 * requested capability. resolve()'s rule 2 (org enforced deny) is a hard stop
 * that overrides defaultEffect, so the request is denied rather than
 * degraded — used in two situations:
 *
 * 1. An API-key-authenticated request whose acting identity we cannot
 *    resolve. API keys authorize AS THEIR CREATOR (api_keys.created_by_id)
 *    — see _fetchAuthz. This fires when that resolution fails: the key row is
 *    missing/soft-deleted/scoped to another org, carries no recorded creator,
 *    or the creator has no principal in this org. In those cases we must NOT
 *    return EMPTY_AUTHZ, because the resolver would then fall through to rule
 *    8 (contract defaultEffect): any capability whose defaultEffect is
 *    "allow" would be granted to the key regardless of the enterprise org's
 *    role-grant matrix — an IAM bypass on the machine-to-machine surface
 *    (this resolver path runs only for enterprise orgs; the tier gate in
 *    check-iam.ts bypasses it for everyone else).
 *
 * 2. ANY caller (human session or API key) when the IAM tables are missing
 *    (Postgres 42P01 — migration not applied). Returning EMPTY_AUTHZ for
 *    human sessions would silently degrade to defaultEffect — "IAM
 *    enforcement is silently disabled in prod" is a critical incident, not a
 *    benign dev convenience — so this fails closed exactly like the
 *    unresolved-API-key case.
 *
 * A dedicated service principal per key is the durable model; the
 * creator-inheritance path is the no-migration fix that unblocks API keys on
 * enterprise orgs today.
 */
function denyAuthz(
  orgId: string,
  workspaceId: string,
  capability: string,
): AuthzData {
  return {
    principal: {
      id: UNRESOLVED_SERVICE_PRINCIPAL_ID,
      kind: "service",
      orgId,
      workspaceId,
    },
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [
      {
        capabilityId: capability,
        scopeKind: "org",
        scopeId: orgId,
        effect: "deny",
        enforced: true,
      },
    ],
    // The synthetic principal above is already a non-human service id, so no
    // caller needs the key's purpose to tell it apart from a person.
    apiKeyPurpose: null,
  };
}

/**
 * Postgres error code for "relation does not exist". Thrown when the IAM
 * migration has not been applied to the target database.
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["code"] === PG_UNDEFINED_TABLE
  );
}

/**
 * The `purpose` string on an API key's `scope` column, or null for a plain
 * org key (no scope, or a scope naming no purpose). Mirrors the same read
 * `readKeyScope` (`packages/iam/src/machine-key-scope.ts`) does against a
 * fresh query; this one reuses the row `_fetchAuthz` already has, rather than
 * adding a second round trip for the same answer.
 */
function purposeOf(scope: unknown): string | null {
  if (typeof scope !== "object" || scope === null) return null;
  const purpose = (scope as { purpose?: unknown }).purpose;
  return typeof purpose === "string" ? purpose : null;
}

export interface FetchAuthzArgs {
  /** The user/apiKey acting on behalf of an org. */
  userId: string | null;
  apiKeyId: string | null;
  orgId: string;
  workspaceId: string;
  capability: string;
}

/**
 * Load all IAM authorization data needed by the resolver for a single
 * invocation. FAILS CLOSED (never EMPTY_AUTHZ) if the IAM tables are absent —
 * see denyAuthz() and the module comment above.
 */
export async function fetchAuthz(args: FetchAuthzArgs): Promise<AuthzData> {
  try {
    return await _fetchAuthz(args);
  } catch (err) {
    if (isUndefinedTable(err)) {
      // IAM migration not yet applied. This is "IAM enforcement is silently
      // disabled in prod" — an operator-actionable incident, so it is logged
      // LOUDLY at error level rather than as a warning easy to miss.
      logger.error(
        { err, capability: args.capability, orgId: args.orgId },
        "[iam] SECURITY ALERT: IAM tables not found (Postgres 42P01) — IAM " +
          "enforcement is NOT ACTIVE for this request. Failing closed (deny) " +
          "instead of silently falling back to defaultEffect. Run " +
          "`pnpm db:migrate` to apply the IAM foundation migration and clear " +
          "this alert.",
      );
      // Fail closed for EVERY caller (human session or API key) — never
      // degrade to EMPTY_AUTHZ/defaultEffect on a missing migration.
      return denyAuthz(args.orgId, args.workspaceId, args.capability);
    }
    throw err;
  }
}

async function _fetchAuthz(args: FetchAuthzArgs): Promise<AuthzData> {
  // grants/roles/policies are scoped by orgId (tenant isolation); the pure
  // resolver applies workspace-scope matching against scope.workspaceId for
  // those (see resolve.ts), so fetching all org rows and filtering in-memory
  // keeps the query count flat. Role *assignments*
  // (principal_role_assignments) can THEMSELVES be workspace-scoped, however,
  // so we must filter those by workspaceId here — see the PRA query below.
  //
  // The read is ORGANISATION-WIDE (withOrgDb, ADR-086), and every query below
  // carries its own org fence or is keyed off rows that do. It has to be: this
  // function runs on EVERY invoke(), including the org-level surfaces that
  // carry no workspace at all, and under an org-only scope `withTenantDb` now
  // refuses a read of any table whose policy names the workspace GUC —
  // `iam.principals` and `iam.principal_role_assignments` are
  // `workspace_nullable`, `auth.api_keys` is `standard`.
  //
  // Widening is not a behaviour change here. The workspace half of the answer
  // is decided by the PRA query's own `workspace_id IS NULL OR workspace_id =
  // <ctx>` predicate, which is what actually scopes a role assignment; RLS was
  // restating it. `principals` is matched on (org, parent_user_id,
  // kind='human'), which a workspace-scoped agent principal cannot satisfy, and
  // `auth.api_keys` is matched on the key's own id. `iam.roles` and
  // `iam.role_grants` are `org_only` and were never narrowed.
  //
  // `withOrgDb` resolves the SAME data plane `withTenantDb` would and asserts
  // the binding the same way, so this conversion cannot move the read to a
  // different database — the thing a conversion to `withSystemDb` silently
  // does (ADR-074, coverage gap 4).
  const { userId, apiKeyId, orgId, workspaceId, capability } = args;

  // An API-key request authenticates with no session user (userId null,
  // apiKeyId set). It authorizes AS THE KEY'S CREATOR (see below): that is
  // the role-grant question. It is never ATTRIBUTED to the creator for
  // evidence when the key is purpose-scoped; see the module note above and
  // `apiKeyPurpose` on AuthzData.
  const isApiKey = !userId && !!apiKeyId;

  // Neither a human session nor an API key — nothing to resolve.
  if (!userId && !apiKeyId) return EMPTY_AUTHZ;

  return withOrgDb(async (tx) => {
    // ── Resolve the EFFECTIVE acting user ─────────────────────────────────────
    // Human session → the session user. API key → the user who CREATED the key
    // (api_keys.created_by_id): the key inherits its creator's role grants.
    // This is what lets API keys work on enterprise orgs, which run the full
    // resolver — the prior behaviour fail-closed EVERY API-key call. The key row
    // is org-scoped, so the active tenant scope (the key's own org/workspace,
    // set by the auth middleware) sees it. A missing/soft-deleted/foreign-org
    // key or a key with no recorded creator yields no effective user → fail
    // closed below (never fall through to defaultEffect on the m2m surface).
    let effectiveUserId: string | null = userId;
    // The key's own scope, read in the same query as its creator so a
    // purpose-scoped key is identifiable without a second round trip. It
    // plays no part in resolving effectiveUserId or in the role-grant match
    // below (those are unchanged, and a machine-bound key still inherits its
    // creator's grants, which is what lets it work on enterprise orgs at all,
    // see the module note above). It answers a narrower question this
    // function did not used to: whether the identity checkIAM is about to
    // attribute a call to is a person, or a credential wearing that person's
    // role grants. See the apiKeyPurpose doc on AuthzData.
    let apiKeyPurpose: string | null = null;
    if (isApiKey) {
      const keyRows = await tx
        .select({
          createdById: schema.apiKeys.createdById,
          scope: schema.apiKeys.scope,
        })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.id, apiKeyId as string),
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.deletedAt),
          ),
        )
        .limit(1);
      const keyRow = keyRows[0];
      effectiveUserId = keyRow?.createdById ?? null;
      apiKeyPurpose = purposeOf(keyRow?.scope);
      if (!effectiveUserId) return denyAuthz(orgId, workspaceId, capability);
    }

    const principalRows = await tx
      .select({
        id: schema.principals.id,
        kind: schema.principals.kind,
        orgId: schema.principals.orgId,
        workspaceId: schema.principals.workspaceId,
      })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          // Match by the effective user's ID stored in parent_user_id. The
          // partial unique index principals_org_parent_user_uniq makes this at
          // most one row per (org, effectiveUserId, kind='human'), so LIMIT 1 is
          // deterministic. kind='human' is REQUIRED here (Agent RBAC Phase 1,
          // migration 20260805120000): a delegated agent principal shares the
          // same parent_user_id as its creator, so without this filter a human
          // caller could non-deterministically resolve to one of their own
          // agents' principals instead of their own.
          eq(schema.principals.parentUserId, effectiveUserId as string),
          eq(schema.principals.kind, "human"),
        ),
      )
      .limit(1);

    const principalRow = principalRows[0];
    if (!principalRow) {
      // The effective user has no principal in this org. For an API key this
      // MUST fail closed (do not degrade to defaultEffect, which would bypass
      // enterprise role grants). For a human session, fall through to
      // defaultEffect via EMPTY_AUTHZ as before.
      return isApiKey ? denyAuthz(orgId, workspaceId, capability) : EMPTY_AUTHZ;
    }

    const principal: ResolvedPrincipal = {
      id: principalRow.id,
      kind: principalRow.kind as "human" | "agent" | "service",
      orgId: principalRow.orgId,
      workspaceId: principalRow.workspaceId,
    };

    // Batch 1 — all roles in this org. The direct-grant and policy tables were
    // dropped in migration 0027 (both replaced by role-based IAM), so there is
    // nothing else to read here and `grants` / `policies` are handed to the
    // resolver empty. That makes rules 1–6 unreachable on this path by
    // construction; rule 7 (role grant), 7.5 (system org Owner), or 8 (contract
    // defaultEffect) decides every request. Keep both collections in the
    // returned AuthzData: the resolver's signature still takes them, and
    // denyAuthz() populates `policies` deliberately to trip rule 2.
    const roleRows = await tx
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));

    const grants: Grant[] = [];
    const policies: Policy[] = [];

    // Batch 2 — two independent queries, run in parallel, both keyed off the
    // roleIds the query above produced.
    const roleIds = roleRows.map((r) => r.id);

    //   a) role_grants for these roles and this capability.
    //   b) role assignments for this principal in this org/workspace. Includes
    //      org-wide (workspaceId IS NULL) and workspace-scoped
    //      (workspaceId = ctx workspaceId) assignments. Non-deleted only.
    const [roleGrantRows, praRows] = await Promise.all([
      roleIds.length > 0
        ? tx
            .select()
            .from(schema.roleGrants)
            .where(
              and(
                inArray(schema.roleGrants.roleId, roleIds),
                eq(schema.roleGrants.capabilityId, capability),
              ),
            )
        : Promise.resolve([] as (typeof schema.roleGrants.$inferSelect)[]),
      tx
        .select({ roleId: schema.principalRoleAssignments.roleId })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, principalRow.id),
            eq(schema.principalRoleAssignments.orgId, orgId),
            // Include assignments that are not soft-deleted.
            isNull(schema.principalRoleAssignments.deletedAt),
            // Exclude expired JIT assignments (expires_at in the past). A NULL
            // expires_at means a permanent (non-JIT) assignment.
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
            ),
            // Honour the assignment's workspace scope: include org-wide
            // assignments (workspace_id IS NULL) and assignments scoped to the
            // workspace this request targets. Without this predicate a
            // workspace-scoped role would leak org-wide (granting role X in
            // workspace B for an assignment made only in workspace A).
            or(
              isNull(schema.principalRoleAssignments.workspaceId),
              eq(schema.principalRoleAssignments.workspaceId, workspaceId),
            ),
          ),
        ),
    ]);

    // Build the set of role IDs this principal is actually a member of.
    // If the principal_role_assignments table has no rows for this principal
    // (e.g. before the seed migration runs), the set is empty — the resolver
    // will fall through to defaultEffect (deny-by-default once enforcement is on).
    const principalRoleIdSet = new Set(praRows.map((r) => r.roleId));

    const roles: Role[] = roleRows.map((r) => ({
      id: r.id,
      name: r.name,
      scopeKind: r.scopeKind as "org" | "workspace",
      orgId: r.orgId,
      // Carry the system-default flag so the resolver can identify the genuine
      // org Owner role (rule 7.5 — org owner super-user). A user-created role
      // named "Owner" has is_system_default = false and does NOT qualify.
      isSystemDefault: r.isSystemDefault,
      // Only include the principal if they have an explicit assignment to
      // this role in the principal_role_assignments table.
      principalIds: principalRoleIdSet.has(r.id) ? [principalRow.id] : [],
    }));

    const roleGrants: RoleGrant[] = roleGrantRows.map((rg) => ({
      roleId: rg.roleId,
      capabilityId: rg.capabilityId,
      effect: rg.effect as "allow" | "deny" | "require_approval",
    }));

    return { principal, grants, roles, roleGrants, policies, apiKeyPurpose };
  });
}
