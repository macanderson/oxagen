/**
 * workbench/agent-roles.ts — server-side wrappers over the agent.role.* +
 * iam.role.list contracts for the Agent Builder's role picker and the agent
 * list's role badge (Agent RBAC Phase 5a, docs/specs/agent-rbac/spec.md §4).
 *
 * Everything flows through invoke() contracts — never a raw query:
 *   - candidate roles come from `list_iam_roles` (grants included),
 *   - the current assignment from `list_agent_roles`,
 *   - the reviewer preview from `get_agent_role`,
 *   - writes via `assign_agent_role` / `revoke_agent_role`.
 *
 * The only non-contract read is the delegation-ceiling PRE-check for the
 * picker's disabled-state UX, which reuses the handler's own exported
 * `assertWithinDelegationCeiling` (packages/agent/src/handlers/_agent-role.ts)
 * inside a tenant-scoped transaction — the same function `assign_agent_role`
 * enforces, so UI and contract can never disagree on the ceiling. It is a UX
 * hint only; the contract remains the authority (a race still rejects with
 * the stable code `agent_role_ceiling_exceeded`).
 *
 * Server-only. Never import from a "use client" module — the client gets
 * plain serializable AgentRoleOption[] via page props.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import type { ResourceScopeCondition } from "@oxagen/oxagen/iam";
import type { AgentRoleListOutput } from "@oxagen/oxagen/contracts/agent.role.list";
import type { AgentRoleGetOutput } from "@oxagen/oxagen/contracts/agent.role.get";
import type { AgentRoleAssignOutput } from "@oxagen/oxagen/contracts/agent.role.assign";
import type { AgentRoleRevokeOutput } from "@oxagen/oxagen/contracts/agent.role.revoke";
import type { IamRoleListOutput } from "@oxagen/oxagen/contracts/iam.role.list";
import { canAccessACL, resolveOrgTier } from "@oxagen/billing";
import { AGENT_ROLE_SPECS } from "@oxagen/handlers/lib/agent-role-defaults";
import {
  DEFAULT_AGENT_ROLE_NAME,
  assertWithinDelegationCeiling,
  resolveRoleByName,
} from "@oxagen/agent/handlers/_agent-role";
import { withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { WorkbenchCtx } from "./scope";

export { DEFAULT_AGENT_ROLE_NAME };

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentRoleGrant = {
  capability: string;
  effect: "allow" | "deny" | "require_approval";
};

/**
 * One selectable role in the builder's Access step. Fully serializable —
 * computed server-side, rendered client-side.
 */
export type AgentRoleOption = {
  roleName: string;
  /** Intent description shown on the role card. */
  description: string;
  isSystemDefault: boolean;
  scopeKind: "org" | "workspace";
  /** Capability grants the role carries (ceiling preview). */
  grants: AgentRoleGrant[];
  /** False when the grant list could not be loaded (degraded render). */
  grantsKnown: boolean;
  /**
   * The role's resource-scope ceiling (graph mode / MCP rules / skills /
   * subagents). Known statically for the three system agent roles (shared
   * AGENT_ROLE_SPECS — the same objects the seeder writes); null for custom
   * roles, whose conditions are not published through a read contract yet —
   * the review panel renders that as "ceiling not published".
   */
  resourceScope: ResourceScopeCondition | null;
  /**
   * Delegation ceiling pre-check (UX only — assign_agent_role re-enforces):
   * false ⇒ the role grants capabilities beyond the viewer's own effective
   * access and renders disabled with an explanatory tooltip.
   */
  withinCeiling: boolean;
  /** Capabilities that exceeded the viewer's ceiling (tooltip content). */
  exceededCapabilities: string[];
};

export type AgentRoleOptionsResult = {
  options: AgentRoleOption[];
  /** True when the org tier allows custom (non-system) agent roles. */
  customRolesAvailable: boolean;
};

// ── Candidate roles ───────────────────────────────────────────────────────────

/**
 * Static fallback options — the three system agent roles from the shared
 * AGENT_ROLE_SPECS, with no grant list and the ceiling assumed satisfied.
 * Used when `list_iam_roles` fails so the picker still renders (degraded,
 * flagged via grantsKnown=false); assign_agent_role remains the authority
 * on every rule the pre-check could not evaluate.
 */
export function fallbackSystemRoleOptions(): AgentRoleOption[] {
  return AGENT_ROLE_SPECS.map((spec) => ({
    roleName: spec.name,
    description: spec.description,
    isSystemDefault: true,
    scopeKind: "org" as const,
    grants: [],
    grantsKnown: false,
    resourceScope: spec.resourceScope,
    withinCeiling: true,
    exceededCapabilities: [],
  }));
}

/**
 * Build the role picker's candidate list: the three system agent roles (all
 * tiers) plus the org's custom roles where the tier allows (enterprise —
 * the same canAccessACL check assign_agent_role enforces). On enterprise
 * orgs each candidate is pre-checked against the viewer's delegation
 * ceiling; on lower tiers checkIAM's human fast-path makes the ceiling
 * vacuously satisfied, mirroring the handler (not a new policy).
 */
export async function listAgentRoleOptions(
  ctx: WorkbenchCtx,
): Promise<AgentRoleOptionsResult> {
  const tier = await resolveOrgTier(ctx.orgId);
  const customRolesAvailable = canAccessACL(tier);

  const out = (await invoke(
    "list_iam_roles",
    { includeGrants: true, limit: 200, offset: 0 },
    ctx,
    { surface: "agent" },
  )) as IamRoleListOutput;

  const options: AgentRoleOption[] = [];

  for (const spec of AGENT_ROLE_SPECS) {
    const row = out.roles.find(
      (r) => r.isSystemDefault && r.name === spec.name,
    );
    options.push({
      roleName: spec.name,
      // The seeded row's description and the spec's are the same text; the
      // spec is the compile-time source of truth for intent wording.
      description: spec.description,
      isSystemDefault: true,
      scopeKind: row?.scopeKind ?? "org",
      grants: row?.grants ?? [],
      grantsKnown: row !== undefined,
      resourceScope: spec.resourceScope,
      withinCeiling: true,
      exceededCapabilities: [],
    });
  }

  if (customRolesAvailable) {
    for (const row of out.roles) {
      if (row.isSystemDefault) continue;
      options.push({
        roleName: row.name,
        description:
          row.description ??
          "Custom role — review its grants before assigning.",
        isSystemDefault: false,
        scopeKind: row.scopeKind,
        grants: row.grants,
        grantsKnown: true,
        resourceScope: null,
        withinCeiling: true,
        exceededCapabilities: [],
      });
    }

    // Delegation-ceiling pre-check (enterprise only — see docstring). Uses the
    // handler's own exported check so the disabled state can never drift from
    // what assign_agent_role would reject. Non-fatal: an unexpected failure
    // leaves the option enabled and lets the contract be the authority.
    await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        withTenantDb(async (tx) => {
          for (const option of options) {
            try {
              const role = await resolveRoleByName(
                tx,
                ctx.orgId,
                option.roleName,
              );
              await assertWithinDelegationCeiling(tx, {
                orgId: ctx.orgId,
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                roleId: role.id,
                roleName: role.name,
              });
            } catch (err) {
              if (isCeilingError(err)) {
                option.withinCeiling = false;
                option.exceededCapabilities = [...err.capabilities];
              }
              // agent_role_not_found (unseeded spec role) or any other error:
              // keep the option enabled — assign_agent_role decides.
            }
          }
        }),
    );
  }

  return { options, customRolesAvailable };
}

// ── Current assignment ────────────────────────────────────────────────────────

/**
 * The agent's currently-assigned role name (most recent active assignment —
 * list_agent_roles returns newest first), or null for a pre-RBAC agent with
 * no principal / no assignment.
 */
export async function getAssignedAgentRole(
  ctx: WorkbenchCtx,
  agentId: string,
): Promise<string | null> {
  const out = (await invoke("list_agent_roles", { agentId }, ctx, {
    surface: "agent",
  })) as AgentRoleListOutput;
  return out.roles[0]?.roleName ?? null;
}

/**
 * Batch role-badge lookup for the agents list: one list_agent_roles call per
 * agent, in parallel, fail-open — a failed lookup renders no badge rather
 * than failing the list.
 */
export async function getAssignedAgentRoles(
  ctx: WorkbenchCtx,
  agentIds: string[],
): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    agentIds.map(async (agentId): Promise<[string, string | null]> => {
      try {
        return [agentId, await getAssignedAgentRole(ctx, agentId)];
      } catch {
        return [agentId, null];
      }
    }),
  );
  return new Map(entries);
}

/**
 * Reviewer preview for one role relative to an agent — grant list plus the
 * live assignment row (null when unassigned). get_agent_role returns the
 * grants even when the role is not attached, which is exactly what the
 * review step needs.
 */
export async function getAgentRolePreview(
  ctx: WorkbenchCtx,
  agentId: string,
  roleName: string,
): Promise<AgentRoleGetOutput> {
  return (await invoke("get_agent_role", { agentId, roleName }, ctx, {
    surface: "agent",
  })) as AgentRoleGetOutput;
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function assignAgentRole(
  ctx: WorkbenchCtx,
  agentId: string,
  roleName: string,
): Promise<AgentRoleAssignOutput> {
  return (await invoke("assign_agent_role", { agentId, roleName }, ctx, {
    surface: "agent",
  })) as AgentRoleAssignOutput;
}

export async function revokeAgentRole(
  ctx: WorkbenchCtx,
  agentId: string,
  roleName: string,
): Promise<AgentRoleRevokeOutput> {
  return (await invoke("revoke_agent_role", { agentId, roleName }, ctx, {
    surface: "agent",
  })) as AgentRoleRevokeOutput;
}

// ── Error narrowing ───────────────────────────────────────────────────────────

/** The delegation-ceiling rejection's stable shape (code + capabilities). */
export function isCeilingError(err: unknown): err is Error & {
  code: "agent_role_ceiling_exceeded";
  capabilities: readonly string[];
} {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "agent_role_ceiling_exceeded" &&
    Array.isArray((err as { capabilities?: unknown }).capabilities)
  );
}
