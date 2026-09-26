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
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import {
  emitAudit,
  findDelegationCeilingViolations,
  postgresDelegationCeilingReads,
  type ConferredGrant,
} from "@oxagen/iam";
import type { ResolveResult, TraceStep } from "@oxagen/oxagen/iam";
import type { CapabilityContext } from "../types";
import { isUuid } from "./_agent-definition";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.role" },
});

// ── Role name constants ──────────────────────────────────────────────────────

/**
 * The system default agent roles (spec §3.2), seeded by
 * tools/scripts/seed-iam-defaults.ts and packages/handlers' bootstrapOrgIAM.
 * Looked up BY NAME at runtime — never by id — so seeding and assignment stay
 * decoupled.
 *
 * Membership here is a TIER EXEMPTION: these names are assignable at every org
 * tier, while any other role is a custom role gated to enterprise. So this set
 * must contain exactly the roles that are actually seeded — nothing more. The
 * spec's back-compat "Agent Legacy (unrestricted)" role is deliberately ABSENT:
 * spec §6 Q1 resolved that this is a pre-launch product with no customers and
 * therefore no back-compat path, so it is never seeded. Listing an unseeded
 * name here would let an org mint a CUSTOM role under that name and have it
 * treated as a tier-exempt system role — an escalation under a name that means
 * "unrestricted".
 */
export const AGENT_SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set([
  "Agent Observer",
  "Agent Contributor",
  "Agent Operator",
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
 * principal provisioning belongs to register_agent only (ADR-192).
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
  /** `draft`, `active`, or `archived` (the column is text with a check constraint). */
  status: string;
}

/**
 * Resolve an agent by public id (agt_…), UUID, or slug — workspace-scoped,
 * live rows only — selecting just what the role handlers need. Throws (plain
 * Error, matching the sibling agent.* handlers' not-found convention) when
 * nothing matches.
 *
 * A retired (archived) agent still resolves here, so `list_agent_roles`,
 * `get_agent_role`, and `revoke_agent_role` keep working on it.
 * `assign_agent_role` refuses it with `assertAgentNotRetired`.
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
      status: schema.agents.status,
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
 * Enforce the delegation ceiling for one role about to be attached to an
 * agent: every capability the role confers (allow / require_approval) is
 * resolved for the ASSIGNING USER through the shared rule in @oxagen/iam
 * (`findDelegationCeilingViolations`, the one implementation the role editor
 * runs as well); any capability where the role would confer a strictly less
 * restrictive outcome than the assigner's own throws
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

  const conferred = await tx
    .select({
      capabilityId: schema.roleGrants.capabilityId,
      effect: schema.roleGrants.effect,
    })
    .from(schema.roleGrants)
    .where(eq(schema.roleGrants.roleId, roleId));

  const violations = await findDelegationCeilingViolations(
    postgresDelegationCeilingReads(tx),
    {
      orgId,
      workspaceId,
      userId,
      conferred: conferred.map((g) => ({
        capabilityId: g.capabilityId,
        effect: g.effect as ConferredGrant["effect"],
      })),
      now: args.now,
    },
  );

  if (violations.length > 0) {
    logger.warn(
      { orgId, workspaceId, userId, roleName, violations },
      "agent.role.assign: delegation ceiling exceeded — rejecting",
    );
    throw new AgentRoleCeilingExceededError(roleName, violations);
  }
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
