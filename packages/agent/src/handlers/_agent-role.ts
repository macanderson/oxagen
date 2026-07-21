// _agent-role.ts — shared plumbing for the agent.role.* handlers
// (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2, §3.4).
//
// An agent's delegated principal (agent.agents.principalId, kind='agent')
// receives IAM roles through iam.principal_role_assignments — the same table
// human role assignments use. This module carries:
//
//   - the system agent role name set + the default role for new agents,
//   - the typed errors (stable `code` fields per oxagen-error-handling),
//   - workspace-scoped agent + role row resolution,
//   - the delegation-ceiling check (reuses the pure IAM resolver in
//     packages/oxagen/src/iam/resolve.ts — never hand-rolled),
//   - the IAM audit emission for assignment/revocation with
//     principal_kind='agent' and the agent id as the audit target.

import { schema, type Tx } from "@oxagen/database";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import pino from "pino";
import { emitAudit } from "@oxagen/iam";
import {
  resolve,
  type Grant,
  type Policy,
  type ResolveResult,
  type Role,
  type RoleGrant,
  type TraceStep,
} from "@oxagen/oxagen/iam";
import { getCapability } from "@oxagen/oxagen/registry";
import type { CapabilityContext } from "../types";
import { isUuid } from "./_agent-definition";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.role" },
});

// ── Role name constants ──────────────────────────────────────────────────────

/**
 * The system default agent roles (spec §3.2), seeded by
 * tools/scripts/seed-iam-defaults.ts. Looked up BY NAME at runtime — never by
 * id — so seeding and assignment stay decoupled. "Agent Legacy (unrestricted)"
 * is the back-compat role backfill assigns to pre-RBAC agents; it is included
 * here so re-attaching it through the contract (rather than only via the
 * backfill script) stays possible.
 */
export const AGENT_SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set([
  "Agent Observer",
  "Agent Contributor",
  "Agent Operator",
  "Agent Legacy (unrestricted)",
]);

/** Auto-assigned to every newly created agent (spec §3.2 — "New agents created after Phase 1 default to Agent Contributor"). */
export const DEFAULT_AGENT_ROLE_NAME = "Agent Contributor";

// ── Typed errors (stable `code` per oxagen-error-handling) ───────────────────

/** The named role does not exist in this org. */
export class AgentRoleNotFoundError extends Error {
  readonly code = "agent_role_not_found";
  constructor(roleName: string) {
    super(`Role '${roleName}' does not exist in this org.`);
    this.name = "AgentRoleNotFoundError";
  }
}

/**
 * The role is a system role that is not an agent role (org Owner, Admin, …).
 * Human org roles are never agent-assignable: the system org Owner role is a
 * resolver super-user (rule 7.5), so attaching it to an unattended automation
 * would be privilege escalation by construction.
 */
export class AgentRoleNotAssignableError extends Error {
  readonly code = "agent_role_not_assignable";
  constructor(roleName: string) {
    super(
      `Role '${roleName}' is a system org role and cannot be assigned to an agent. ` +
        `Assignable system roles: ${[...AGENT_SYSTEM_ROLE_NAMES].join(", ")} — or a custom role (enterprise).`,
    );
    this.name = "AgentRoleNotAssignableError";
  }
}

/**
 * Delegation ceiling (spec §0/§3.1): a user may never attach a role whose
 * grants exceed their OWN effective grants — otherwise assigning a role to an
 * agent would be a privilege-escalation channel.
 */
export class AgentRoleCeilingExceededError extends Error {
  readonly code = "agent_role_ceiling_exceeded";
  readonly capabilities: readonly string[];
  constructor(roleName: string, capabilities: readonly string[]) {
    super(
      `Role '${roleName}' grants capabilities beyond your own effective access ` +
        `(${capabilities.join(", ")}). You cannot delegate permissions you do not hold.`,
    );
    this.name = "AgentRoleCeilingExceededError";
    this.capabilities = capabilities;
  }
}

/**
 * The agent exists but carries no delegated principal — pre-Phase-1 data that
 * cannot anchor role assignments. Fail closed rather than inventing one here:
 * principal provisioning belongs to agent.definition.create only.
 */
export class AgentPrincipalMissingError extends Error {
  readonly code = "agent_principal_missing";
  constructor(agentId: string) {
    super(
      `Agent '${agentId}' has no delegated IAM principal — it predates Agent RBAC provisioning.`,
    );
    this.name = "AgentPrincipalMissingError";
  }
}

// ── Row resolution ───────────────────────────────────────────────────────────

export interface AgentRoleAgentRow {
  id: string;
  publicId: string;
  slug: string;
  principalId: string | null;
}

/**
 * Resolve an agent by public id (agt_…), UUID, or slug — workspace-scoped,
 * live rows only — selecting just what the role handlers need. Throws (plain
 * Error, matching the sibling agent.* handlers' not-found convention) when
 * nothing matches.
 */
export async function resolveAgentForRoles(
  tx: Tx,
  identifier: string,
  workspaceId: string,
): Promise<AgentRoleAgentRow> {
  const matchColumn = isUuid(identifier)
    ? eq(schema.agents.id, identifier)
    : identifier.startsWith("agt_")
      ? eq(schema.agents.publicId, identifier)
      : eq(schema.agents.slug, identifier);

  const [row] = await tx
    .select({
      id: schema.agents.id,
      publicId: schema.agents.publicId,
      slug: schema.agents.slug,
      principalId: schema.agents.principalId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        matchColumn,
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new Error(`Agent not found: ${identifier}`);
  return row;
}

export interface AgentRoleRoleRow {
  id: string;
  publicId: string;
  name: string;
  scopeKind: string;
  isSystemDefault: boolean;
}

/** Resolve a role by name in the org. Throws AgentRoleNotFoundError when absent. */
export async function resolveRoleByName(
  tx: Tx,
  orgId: string,
  roleName: string,
): Promise<AgentRoleRoleRow> {
  const [row] = await tx
    .select({
      id: schema.roles.id,
      publicId: schema.roles.publicId,
      name: schema.roles.name,
      scopeKind: schema.roles.scopeKind,
      isSystemDefault: schema.roles.isSystemDefault,
    })
    .from(schema.roles)
    .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.name, roleName)))
    .limit(1);

  if (!row) throw new AgentRoleNotFoundError(roleName);
  return row;
}

// ── Delegation ceiling ───────────────────────────────────────────────────────

/**
 * Outcome restrictiveness rank (mirrors the deny-wins merge in resolve.ts):
 * a role grant EXCEEDS the assigner's ceiling when it confers a strictly
 * LESS restrictive outcome than the assigner's own resolution.
 */
const OUTCOME_RANK: Record<"allow" | "pending_approval" | "deny", number> = {
  allow: 0,
  pending_approval: 1,
  deny: 2,
};

/**
 * Enforce the delegation ceiling for one role about to be attached to an
 * agent: every capability the role confers (allow / require_approval) is
 * resolved for the ASSIGNING USER through the ordinary pure IAM resolver
 * (packages/oxagen/src/iam/resolve.ts) with the assigner's own pre-fetched
 * roles/assignments; any capability where the role would confer a strictly
 * less restrictive outcome than the assigner's own throws
 * AgentRoleCeilingExceededError.
 *
 * Only meaningful on enterprise orgs: for non-enterprise tiers checkIAM's
 * tier fast-path resolves the HUMAN assigner to an unconditional allow for
 * every capability (see packages/iam/check-iam.ts), so the ceiling is
 * vacuously satisfied — callers skip this function there, mirroring that
 * fast-path rather than re-deriving it.
 *
 * All queries run sequentially inside the caller's transaction so the check
 * and the assignment write are one atomic, RLS-scoped unit (no TOCTOU).
 */
export async function assertWithinDelegationCeiling(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    /** The effective assigning user (session user, or the API key's creator). */
    userId: string;
    roleId: string;
    roleName: string;
    now?: Date;
  },
): Promise<void> {
  const { orgId, workspaceId, userId, roleId, roleName } = args;
  const now = args.now ?? new Date();

  // 1. What does the target role confer? deny grants never widen anything.
  const targetGrants = await tx
    .select({
      capabilityId: schema.roleGrants.capabilityId,
      effect: schema.roleGrants.effect,
    })
    .from(schema.roleGrants)
    .where(eq(schema.roleGrants.roleId, roleId));

  const conferring = targetGrants.filter((g) => g.effect !== "deny");
  if (conferring.length === 0) return;
  const capabilityIds = [...new Set(conferring.map((g) => g.capabilityId))];

  // 2. The assigner's own IAM data — same shape fetch-authz feeds the
  //    resolver. A missing principal contributes no roles: resolution falls
  //    through to each capability's contract defaultEffect.
  const [principalRow] = await tx
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

  const assignerPrincipalId =
    principalRow?.id ?? "00000000-0000-0000-0000-000000000000";

  const roleRows = await tx
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      scopeKind: schema.roles.scopeKind,
      orgId: schema.roles.orgId,
      isSystemDefault: schema.roles.isSystemDefault,
    })
    .from(schema.roles)
    .where(eq(schema.roles.orgId, orgId));

  const praRows = principalRow
    ? await tx
        .select({ roleId: schema.principalRoleAssignments.roleId })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, principalRow.id),
            eq(schema.principalRoleAssignments.orgId, orgId),
            isNull(schema.principalRoleAssignments.deletedAt),
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
            ),
            or(
              isNull(schema.principalRoleAssignments.workspaceId),
              eq(schema.principalRoleAssignments.workspaceId, workspaceId),
            ),
          ),
        )
    : [];

  const memberRoleIds = new Set(praRows.map((r) => r.roleId));
  const roles: Role[] = roleRows.map((r) => ({
    id: r.id,
    name: r.name,
    scopeKind: r.scopeKind as "org" | "workspace",
    orgId: r.orgId,
    principalIds: memberRoleIds.has(r.id) ? [assignerPrincipalId] : [],
    isSystemDefault: r.isSystemDefault,
  }));

  const roleIds = roleRows.map((r) => r.id);
  const assignerRoleGrantRows =
    roleIds.length > 0
      ? await tx
          .select({
            roleId: schema.roleGrants.roleId,
            capabilityId: schema.roleGrants.capabilityId,
            effect: schema.roleGrants.effect,
          })
          .from(schema.roleGrants)
          .where(
            and(
              inArray(schema.roleGrants.roleId, roleIds),
              inArray(schema.roleGrants.capabilityId, capabilityIds),
            ),
          )
      : [];

  const roleGrants: RoleGrant[] = assignerRoleGrantRows.map((rg) => ({
    roleId: rg.roleId,
    capabilityId: rg.capabilityId,
    effect: rg.effect as RoleGrant["effect"],
  }));

  // Direct grants and policies tables were dropped in migration 0027 (see
  // packages/iam/src/fetch-authz.ts) — role-based evaluation only.
  const grants: Grant[] = [];
  const policies: Policy[] = [];

  // 3. Resolve the assigner per conferred capability via the pure resolver
  //    and compare restrictiveness. Unknown capabilities (a stale role grant
  //    naming a since-removed contract) fail closed to defaultEffect "deny".
  const violations: string[] = [];
  for (const grant of conferring) {
    const conferredOutcome =
      grant.effect === "allow" ? "allow" : "pending_approval";
    const assignerResolution = resolve({
      principal: {
        id: assignerPrincipalId,
        kind: "human",
        orgId,
        workspaceId,
      },
      capability: grant.capabilityId,
      scope: { kind: "workspace", orgId, workspaceId },
      grants,
      roles,
      roleGrants,
      policies,
      defaultEffect: getCapability(grant.capabilityId)?.defaultEffect ?? "deny",
      now,
    });
    if (
      OUTCOME_RANK[conferredOutcome] < OUTCOME_RANK[assignerResolution.outcome]
    ) {
      violations.push(grant.capabilityId);
    }
  }

  if (violations.length > 0) {
    logger.warn(
      { orgId, workspaceId, userId, roleName, violations },
      "agent.role.assign: delegation ceiling exceeded — rejecting",
    );
    throw new AgentRoleCeilingExceededError(roleName, [...new Set(violations)]);
  }
}

/**
 * Resolve the effective assigning user for the ceiling: the session user, or
 * — on the machine-to-machine surface — the API key's creator
 * (api_keys.created_by_user_id), exactly how packages/iam/fetch-authz.ts
 * authorizes keys. An unresolvable key fails closed.
 */
export async function resolveEffectiveAssigner(
  tx: Tx,
  ctx: Pick<CapabilityContext, "orgId" | "userId" | "apiKeyId">,
): Promise<string> {
  if (ctx.userId) return ctx.userId;
  if (ctx.apiKeyId) {
    const [keyRow] = await tx
      .select({ createdByUserId: schema.apiKeys.createdByUserId })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, ctx.apiKeyId),
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.deletedAt),
        ),
      )
      .limit(1);
    if (keyRow?.createdByUserId) return keyRow.createdByUserId;
  }
  throw new Error("Unauthorized: no authenticated principal");
}

// ── Audit emission ───────────────────────────────────────────────────────────

/**
 * Emit the existing IAM audit event (packages/iam/src/emit-audit.ts) for an
 * agent role assignment/revocation, with the AGENT principal as the acting
 * principal (`principal_kind='agent'`, spec §2 goal 6) and the agent as the
 * audit target. Fire-and-forget: failures are logged loudly but never block
 * the response path (same contract as checkIAM's emission).
 */
export function emitAgentRoleAudit(args: {
  capability: string;
  ctx: CapabilityContext;
  agentPrincipalId: string;
  agentPublicId: string;
  roleName: string;
  action: "assigned" | "revoked";
  actorUserId: string;
  rawInputJson: string;
}): void {
  const {
    capability,
    ctx,
    agentPrincipalId,
    agentPublicId,
    roleName,
    action,
    actorUserId,
    rawInputJson,
  } = args;

  const step: TraceStep = {
    rule: `agent_role_${action}`,
    description: `Role '${roleName}' ${action} on agent principal by user ${actorUserId}`,
    decided: true,
    outcome: "allow",
  };
  const result: ResolveResult = {
    outcome: "allow",
    trace: { steps: [step], decidedBy: step },
  };

  emitAudit({
    capability,
    ctx,
    principal: {
      id: agentPrincipalId,
      kind: "agent",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    result,
    trace: result.trace,
    rawInputJson,
    target: { kind: "agent", id: agentPublicId },
  }).catch((err: unknown) => {
    logger.error(
      { err, capability, agentPublicId, roleName },
      "agent.role: IAM audit emission failed (fire-and-forget — response path unaffected)",
    );
  });
}
