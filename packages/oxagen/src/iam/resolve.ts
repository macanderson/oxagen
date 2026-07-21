// resolve.ts — pure IAM capability resolver (OXA-1390, Phase 3).
//
// This module is intentionally dependency-free: it takes pre-fetched data from
// the database (grants, roles, policies) and returns a decision + trace.
// No I/O. Easy to unit-test exhaustively.
//
// Resolution order (plan.md §Phase3 / IA spec §12):
//   Rule 1: Workspace explicit deny   → DENY
//   Rule 2: Org enforced deny         → DENY
//   Rule 3: Workspace explicit allow  → ALLOW
//   Rule 4: Org enforced allow        → ALLOW
//   Rule 5: Workspace require_approval → PENDING
//   Rule 6: Org default grant         → inherit org grant
//   Rule 7: Role-inherited grant      → inherit role grant
//   Rule 7.5: Org owner super-user    → ALLOW (system org Owner role)
//   Rule 8: Default effect (contract) → use contract.defaultEffect

import type { CapabilityEffect, ResolvedPrincipal } from "../types";
import {
  evaluateConditions,
  parseResourceScope,
  type AgentsScope,
  type ConditionEvalContext,
  type GraphBudget,
  type GraphMode,
  type GraphScope,
  type McpScopeRule,
  type ResourceScope,
  type SkillsScope,
} from "./conditions";

// Re-export the scope types for downstream consumers (kernel, packages/ontology,
// tool materialization, MCP binding) so they can depend on the resolver module
// alone.
export type {
  AgentsScope,
  GraphBudget,
  GraphMode,
  GraphScope,
  McpScopeRule,
  ResourceScope,
  SkillsScope,
};

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Name of the system-default org-scoped role that owns the organization.
 * The org owner is the organization's root principal — a super-user (rule 7.5).
 * MUST match the role name written by the IAM seeder
 * (`packages/handlers/src/iam-provision.ts`, which imports this constant).
 */
export const ORG_OWNER_ROLE_NAME = "Owner";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScopeKind = "org" | "workspace";

export interface ResolveScope {
  kind: ScopeKind;
  orgId: string;
  workspaceId?: string;
}

export interface Grant {
  principalId: string;
  capabilityId: string;
  scopeKind: ScopeKind;
  scopeId: string;
  effect: CapabilityEffect;
  conditionsJsonb?: unknown;
  expiresAt?: Date | null;
}

export interface RoleGrant {
  roleId: string;
  capabilityId: string;
  effect: CapabilityEffect;
}

export interface Role {
  id: string;
  name: string;
  scopeKind: ScopeKind;
  orgId: string;
  principalIds: string[];
  /**
   * True when this is a system-provisioned role (iam.roles.is_system_default).
   * Used by rule 7.5 to identify the genuine org Owner role — a user-created
   * role merely named "Owner" (is_system_default = false) is NOT a super-user.
   */
  isSystemDefault?: boolean;
}

export interface Policy {
  capabilityId: string;
  scopeKind: ScopeKind;
  scopeId?: string | null;
  effect: CapabilityEffect;
  enforced: boolean;
  conditionsJsonb?: unknown;
}

export interface TraceStep {
  rule: string;
  description: string;
  decided: boolean;
  outcome?: "allow" | "deny" | "pending_approval";
}

export interface Trace {
  steps: readonly TraceStep[];
  decidedBy: TraceStep;
}

export type ResolveResult =
  | { outcome: "allow"; trace: Trace }
  | {
      outcome: "deny";
      reason:
        | "no_grant"
        | "workspace_deny"
        | "org_enforced_deny"
        | "expired"
        | "condition_failed";
      trace: Trace;
    }
  | { outcome: "pending_approval"; trace: Trace };

export interface ResolveInput {
  /** The principal whose access is being evaluated. */
  principal: ResolvedPrincipal;
  /** The capability identifier string, e.g. "org.create". */
  capability: string;
  /** The scope of the invocation — org or workspace. */
  scope: ResolveScope;
  /** Direct grants for this principal. Pre-fetched by the caller. */
  grants: readonly Grant[];
  /**
   * Roles assigned to this principal. Each role carries a principalIds list
   * so the resolver can check membership without a join.
   */
  roles: readonly Role[];
  /**
   * Role-grants: role → capability → effect mappings. Pre-fetched. */
  roleGrants: readonly RoleGrant[];
  /** Policies for this capability. Pre-fetched. */
  policies: readonly Policy[];
  /**
   * Contract-level fallback effect when no grant/role/policy matches
   * (rule 8). Read from CapabilityDeclaration.defaultEffect.
   */
  defaultEffect: CapabilityEffect;
  /**
   * Wall-clock time of the invocation. Used to evaluate time_window
   * conditions. When absent, defaults to `new Date()` inside the resolver
   * so callers that have not yet adopted the field are not broken.
   */
  now?: Date;
  /**
   * Client IP address of the request. Used to evaluate ip_ranges / ip_allow
   * conditions. Null / undefined means the IP is unknown — any IP-based
   * condition will fail-closed (deny) when this is absent.
   */
  clientIp?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExpired(g: Grant): boolean {
  if (!g.expiresAt) return false;
  return g.expiresAt < new Date();
}

/**
 * Evaluate conditionsJsonb on a grant or policy against the request context.
 * Delegates to evaluateConditions (conditions.ts) which implements the full
 * condition language (time_window, ip_ranges, ip_allow). Returns true when
 * all conditions are satisfied; false (fail-closed) otherwise.
 */
function conditionsMet(
  conditionsJsonb: unknown,
  evalCtx: ConditionEvalContext,
): boolean {
  return evaluateConditions(conditionsJsonb, evalCtx);
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Pure resolver: takes pre-fetched IAM data and returns a decision + trace.
 * No I/O — all DB reads happen before this function is called.
 */
export function resolve(input: ResolveInput): ResolveResult {
  const {
    principal,
    capability,
    scope,
    grants,
    roles,
    roleGrants,
    policies,
    defaultEffect,
  } = input;

  // Build the condition evaluation context once and reuse for all grants/policies.
  const evalCtx: ConditionEvalContext = {
    now: input.now ?? new Date(),
    clientIp: input.clientIp ?? null,
  };

  // Capability matching is exact: a grant, policy, or role-grant row is relevant
  // only when it is keyed by this capability's canonical name.
  const matchesCapability = (id: string): boolean => id === capability;

  const steps: TraceStep[] = [];

  // Filter grants to those relevant to this (principal, capability, scope).
  //
  // A grant is relevant when it is a workspace grant matching the invocation's
  // workspaceId (only meaningful on a workspace-scoped invocation), OR an
  // org grant matching the invocation's orgId. Org grants are ALWAYS relevant —
  // including during a workspace-scoped invocation — so that Rule 6 (org default
  // grant inheritance) can fire. Filtering org grants out on workspace scope
  // (the previous behaviour) made Rule 6 dead for every workspace invocation,
  // wrongly denying principals who hold only an org-level allow grant.
  const relevantGrants = grants.filter(
    (g) =>
      g.principalId === principal.id &&
      matchesCapability(g.capabilityId) &&
      ((g.scopeKind === "workspace" &&
        scope.kind === "workspace" &&
        g.scopeId === scope.workspaceId) ||
        (g.scopeKind === "org" && g.scopeId === scope.orgId)),
  );

  // Helper: split grants by scope_kind for rules 1-6.
  const workspaceGrants = relevantGrants.filter(
    (g) => g.scopeKind === "workspace",
  );
  const orgGrants = relevantGrants.filter((g) => g.scopeKind === "org");

  // Org enforced policies (rules 2, 4) apply regardless of the invocation's scope_kind —
  // an org enforced deny is a hard stop that cannot be overridden by a workspace grant.
  // We therefore filter org policies separately from the scope filter.
  //
  // IMPORTANT: conditions are evaluated here so that a conditional enforced policy
  // is only active when its conditions currently hold. A deny-policy whose conditions
  // do NOT hold is NOT active — it should not deny. This closes the gap noted in
  // OXA-1390 where org policies had no condition evaluation at all.
  const orgEnforcedDenyPolicies = policies.filter(
    (p) =>
      matchesCapability(p.capabilityId) &&
      p.enforced &&
      p.effect === "deny" &&
      p.scopeKind === "org" &&
      (p.scopeId === scope.orgId ||
        p.scopeId === null ||
        p.scopeId === undefined) &&
      conditionsMet(p.conditionsJsonb, evalCtx),
  );
  const orgEnforcedAllowPolicies = policies.filter(
    (p) =>
      matchesCapability(p.capabilityId) &&
      p.enforced &&
      p.effect === "allow" &&
      p.scopeKind === "org" &&
      (p.scopeId === scope.orgId ||
        p.scopeId === null ||
        p.scopeId === undefined) &&
      conditionsMet(p.conditionsJsonb, evalCtx),
  );

  // ── Rule 1: Workspace explicit deny ────────────────────────────────────────
  const wsDenyGrant =
    scope.kind === "workspace"
      ? workspaceGrants.find(
          (g) =>
            g.effect === "deny" &&
            !isExpired(g) &&
            conditionsMet(g.conditionsJsonb, evalCtx),
        )
      : undefined;

  if (wsDenyGrant) {
    const step: TraceStep = {
      rule: "1:workspace_deny",
      description: "Workspace explicit deny grant found",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "workspace_deny",
      trace: { steps, decidedBy: step },
    };
  }
  steps.push({
    rule: "1:workspace_deny",
    description: "No workspace deny grant",
    decided: false,
  });

  // ── Rule 2: Org enforced deny ───────────────────────────────────────────────
  const orgEnforcedDeny = orgEnforcedDenyPolicies[0];
  if (orgEnforcedDeny) {
    const step: TraceStep = {
      rule: "2:org_enforced_deny",
      description: "Org enforced deny policy found",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "org_enforced_deny",
      trace: { steps, decidedBy: step },
    };
  }
  steps.push({
    rule: "2:org_enforced_deny",
    description: "No org enforced deny policy",
    decided: false,
  });

  // ── Rule 3: Workspace explicit allow ───────────────────────────────────────
  if (scope.kind === "workspace") {
    const wsAllowGrant = workspaceGrants.find(
      (g) =>
        g.effect === "allow" &&
        !isExpired(g) &&
        conditionsMet(g.conditionsJsonb, evalCtx),
    );
    if (wsAllowGrant) {
      const step: TraceStep = {
        rule: "3:workspace_allow",
        description: "Workspace explicit allow grant found",
        decided: true,
        outcome: "allow",
      };
      steps.push(step);
      return { outcome: "allow", trace: { steps, decidedBy: step } };
    }
    // Check for expired/condition-failed workspace grants that would have matched.
    const wsExpiredGrant = workspaceGrants.find(
      (g) => g.effect === "allow" && isExpired(g),
    );
    if (wsExpiredGrant) {
      const step: TraceStep = {
        rule: "3:workspace_allow",
        description: "Workspace allow grant found but expired",
        decided: true,
        outcome: "deny",
      };
      steps.push(step);
      return {
        outcome: "deny",
        reason: "expired",
        trace: { steps, decidedBy: step },
      };
    }
    const wsConditionFailed = workspaceGrants.find(
      (g) =>
        g.effect === "allow" &&
        !isExpired(g) &&
        !conditionsMet(g.conditionsJsonb, evalCtx),
    );
    if (wsConditionFailed) {
      const step: TraceStep = {
        rule: "3:workspace_allow",
        description: "Workspace allow grant found but condition failed",
        decided: true,
        outcome: "deny",
      };
      steps.push(step);
      return {
        outcome: "deny",
        reason: "condition_failed",
        trace: { steps, decidedBy: step },
      };
    }
  }
  steps.push({
    rule: "3:workspace_allow",
    description: "No workspace allow grant",
    decided: false,
  });

  // ── Rule 4: Org enforced allow ─────────────────────────────────────────────
  const orgEnforcedAllow = orgEnforcedAllowPolicies[0];
  if (orgEnforcedAllow) {
    const step: TraceStep = {
      rule: "4:org_enforced_allow",
      description: "Org enforced allow policy found",
      decided: true,
      outcome: "allow",
    };
    steps.push(step);
    return { outcome: "allow", trace: { steps, decidedBy: step } };
  }
  steps.push({
    rule: "4:org_enforced_allow",
    description: "No org enforced allow policy",
    decided: false,
  });

  // ── Rule 5: Workspace require_approval ─────────────────────────────────────
  if (scope.kind === "workspace") {
    const wsApprovalGrant = workspaceGrants.find(
      (g) =>
        g.effect === "require_approval" &&
        !isExpired(g) &&
        conditionsMet(g.conditionsJsonb, evalCtx),
    );
    if (wsApprovalGrant) {
      const step: TraceStep = {
        rule: "5:workspace_require_approval",
        description: "Workspace require_approval grant found",
        decided: true,
        outcome: "pending_approval",
      };
      steps.push(step);
      return { outcome: "pending_approval", trace: { steps, decidedBy: step } };
    }
  }
  steps.push({
    rule: "5:workspace_require_approval",
    description: "No workspace require_approval grant",
    decided: false,
  });

  // ── Rule 6: Org default grant ──────────────────────────────────────────────
  // Deny-wins: when a principal holds multiple conflicting org grants for the
  // same capability + scope, deny must be checked BEFORE allow/require_approval
  // — a principal can never escape an explicit org-level deny by also holding
  // an allow grant at the same scope. (Mirrors the deny-before-allow ordering
  // already enforced across rules 1/3 at the workspace level.)
  const orgDenyGrant = orgGrants.find(
    (g) =>
      g.effect === "deny" &&
      !isExpired(g) &&
      conditionsMet(g.conditionsJsonb, evalCtx),
  );
  if (orgDenyGrant) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org deny grant inherited",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "no_grant",
      trace: { steps, decidedBy: step },
    };
  }
  const orgAllowGrant = orgGrants.find(
    (g) =>
      g.effect === "allow" &&
      !isExpired(g) &&
      conditionsMet(g.conditionsJsonb, evalCtx),
  );
  if (orgAllowGrant) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org allow grant inherited",
      decided: true,
      outcome: "allow",
    };
    steps.push(step);
    return { outcome: "allow", trace: { steps, decidedBy: step } };
  }
  const orgApprovalGrant = orgGrants.find(
    (g) =>
      g.effect === "require_approval" &&
      !isExpired(g) &&
      conditionsMet(g.conditionsJsonb, evalCtx),
  );
  if (orgApprovalGrant) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org require_approval grant inherited",
      decided: true,
      outcome: "pending_approval",
    };
    steps.push(step);
    return { outcome: "pending_approval", trace: { steps, decidedBy: step } };
  }
  // Check expired org grants.
  const orgExpiredGrant = orgGrants.find((g) => isExpired(g));
  if (orgExpiredGrant) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org grant found but expired",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "expired",
      trace: { steps, decidedBy: step },
    };
  }
  // Check condition-failed org grants.
  const orgConditionFailed = orgGrants.find(
    (g) => !conditionsMet(g.conditionsJsonb, evalCtx),
  );
  if (orgConditionFailed) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org grant found but condition failed",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "condition_failed",
      trace: { steps, decidedBy: step },
    };
  }
  steps.push({
    rule: "6:org_grant",
    description: "No org grant found",
    decided: false,
  });

  // ── Rule 7: Role-inherited grant ───────────────────────────────────────────
  // Find all roles this principal is a member of.
  const principalRoles = roles.filter((r) =>
    r.principalIds.includes(principal.id),
  );
  const principalRoleIds = principalRoles.map((r) => r.id);

  // Find role grants for this capability from the principal's roles.
  const matchingRoleGrants = roleGrants.filter(
    (rg) =>
      principalRoleIds.includes(rg.roleId) &&
      matchesCapability(rg.capabilityId),
  );

  const roleAllowGrant = matchingRoleGrants.find((rg) => rg.effect === "allow");
  if (roleAllowGrant) {
    const step: TraceStep = {
      rule: "7:role_grant",
      description: `Role grant 'allow' via role ${roleAllowGrant.roleId}`,
      decided: true,
      outcome: "allow",
    };
    steps.push(step);
    return { outcome: "allow", trace: { steps, decidedBy: step } };
  }
  const roleApprovalGrant = matchingRoleGrants.find(
    (rg) => rg.effect === "require_approval",
  );
  if (roleApprovalGrant) {
    const step: TraceStep = {
      rule: "7:role_grant",
      description: `Role grant 'require_approval' via role ${roleApprovalGrant.roleId}`,
      decided: true,
      outcome: "pending_approval",
    };
    steps.push(step);
    return { outcome: "pending_approval", trace: { steps, decidedBy: step } };
  }
  const roleDenyGrant = matchingRoleGrants.find((rg) => rg.effect === "deny");
  if (roleDenyGrant) {
    const step: TraceStep = {
      rule: "7:role_grant",
      description: `Role grant 'deny' via role ${roleDenyGrant.roleId}`,
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return {
      outcome: "deny",
      reason: "no_grant",
      trace: { steps, decidedBy: step },
    };
  }
  steps.push({
    rule: "7:role_grant",
    description: "No matching role grant",
    decided: false,
  });

  // ── Rule 7.5: Org owner super-user ─────────────────────────────────────────
  // The system-default org "Owner" role is the organization's root principal.
  // Once every explicit grant/policy above has been evaluated and none decided,
  // an owner is ALLOWED by default — they are never locked out of a capability
  // they have not explicitly restricted. This makes owner access independent of
  // per-capability default-role seeding: a capability added AFTER the org was
  // provisioned has no Owner role_grant, and would otherwise fall through to a
  // `deny` defaultEffect on enterprise orgs (the only tier that runs this
  // resolver — see check-iam.ts), silently locking the owner out of new
  // features. Explicit denial is still honoured: rules 1, 2, 6 and 7 (workspace
  // deny, org enforced deny, org/role deny grants) all run first and hard-stop,
  // so an owner CAN restrict themselves "through config". Only system-default
  // org Owner roles qualify (isSystemDefault) — a user-created role merely named
  // "Owner" does not inherit super-user rights.
  const isOrgOwner = principalRoles.some(
    (r) =>
      r.scopeKind === "org" &&
      r.name === ORG_OWNER_ROLE_NAME &&
      r.isSystemDefault === true,
  );
  if (isOrgOwner) {
    const step: TraceStep = {
      rule: "7.5:org_owner_superuser",
      description: "Principal is the system org Owner — super-user allow",
      decided: true,
      outcome: "allow",
    };
    steps.push(step);
    return { outcome: "allow", trace: { steps, decidedBy: step } };
  }
  steps.push({
    rule: "7.5:org_owner_superuser",
    description: "Principal is not a system org owner",
    decided: false,
  });

  // ── Rule 8: Default effect ─────────────────────────────────────────────────
  const defaultOutcome: "allow" | "deny" | "pending_approval" =
    defaultEffect === "require_approval" ? "pending_approval" : defaultEffect;
  const defaultStep: TraceStep = {
    rule: "8:default",
    description: `No grant matched — using contract defaultEffect: ${defaultEffect}`,
    decided: true,
    outcome: defaultOutcome,
  };
  steps.push(defaultStep);

  if (defaultEffect === "allow") {
    return { outcome: "allow", trace: { steps, decidedBy: defaultStep } };
  }
  if (defaultEffect === "require_approval") {
    return {
      outcome: "pending_approval",
      trace: { steps, decidedBy: defaultStep },
    };
  }
  return {
    outcome: "deny",
    reason: "no_grant",
    trace: { steps, decidedBy: defaultStep },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent RBAC — effective-permission resolution for agent principals.
//
// Every deployed agent is a first-class IAM principal (iam.principals
// kind='agent'). An agent acts FOR a human, so its effective permissions are
// the INTERSECTION of its own grants and the invoking human's grants — an
// agent can never exceed the human it acts for. Effects merge deny-wins
// (deny > require_approval/ask > allow) and resourceScope ceilings intersect
// dimension-wise. A subagent additionally inherits its parent run's effective
// scope as a narrowing-only ceiling.
// ═══════════════════════════════════════════════════════════════════════════

/** Effect of an MCP tool invocation under an effective scope. */
export type McpEffect = "allow" | "deny" | "ask";

/**
 * The MCP dimension of an EFFECTIVE (already-intersected) scope.
 *
 * Two first-match-wins rule lists cannot in general be flattened into a
 * single first-match-wins list without changing semantics, so the effective
 * scope keeps every contributing rule set. Evaluation runs each set
 * independently (first match wins, same glob semantics as
 * packages/mcp-config/src/permissions.ts) and takes the most restrictive
 * result: deny > ask > allow. An unmatched set is unrestricted (allow).
 */
export interface EffectiveMcpScope {
  ruleSets: readonly (readonly McpScopeRule[])[];
}

/**
 * An effective (resolved, intersected) resource scope — the object downstream
 * consumers (kernel, packages/ontology, tool materialization, MCP binding)
 * read. Identical to ResourceScope except that the mcp dimension carries the
 * full list of contributing rule sets.
 *
 * `undefined` on any dimension = unrestricted on that dimension.
 */
export interface EffectiveScope {
  graph?: GraphScope;
  mcp?: EffectiveMcpScope;
  skills?: SkillsScope;
  agents?: AgentsScope;
}

/** A scope input to intersection: either a raw ResourceScope (single mcp rule
 * list) or an already-effective scope (mcp rule sets). */
export type ScopeLike = ResourceScope | EffectiveScope | Record<string, never>;

// ── Glob matching (same semantics as packages/mcp-config/src/permissions.ts) ──
// Re-implemented locally so this module stays dependency-free.
function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
  } catch {
    return false; // invalid pattern — no match rather than crash
  }
}

// ── Scope intersection helpers ────────────────────────────────────────────────

/** Restrictiveness ordering for MCP effects: deny > ask > allow. */
const MCP_EFFECT_RANK: Record<McpEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Set intersection. `undefined` = unrestricted on that side. When
 * `emptyIsUnrestricted` is true (graph labels/relationshipTypes per spec:
 * "undefined/empty = all"), an empty array is also unrestricted; otherwise an
 * empty array is the empty set (nothing allowed).
 */
function intersectStringSets(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
  emptyIsUnrestricted = false,
): string[] | undefined {
  const unrestricted = (s: readonly string[] | undefined): boolean =>
    s === undefined || (emptyIsUnrestricted && s.length === 0);
  if (unrestricted(a) && unrestricted(b)) return undefined;
  if (unrestricted(a)) return [...(b as readonly string[])];
  if (unrestricted(b)) return [...(a as readonly string[])];
  const bSet = new Set(b);
  return (a as readonly string[]).filter((v) => bSet.has(v));
}

/** Element-wise min with undefined = no ceiling on that side. */
function minOptional(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Mode min over the ordering read < extend; undefined = unrestricted. */
function minMode(
  a: GraphMode | undefined,
  b: GraphMode | undefined,
): GraphMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a === "read" || b === "read" ? "read" : "extend";
}

function intersectBudgets(
  a: GraphBudget | undefined,
  b: GraphBudget | undefined,
): GraphBudget | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: GraphBudget = {};
  const maxHops = minOptional(a?.maxHops, b?.maxHops);
  const maxNodes = minOptional(a?.maxNodes, b?.maxNodes);
  const maxTraversalMs = minOptional(a?.maxTraversalMs, b?.maxTraversalMs);
  if (maxHops !== undefined) merged.maxHops = maxHops;
  if (maxNodes !== undefined) merged.maxNodes = maxNodes;
  if (maxTraversalMs !== undefined) merged.maxTraversalMs = maxTraversalMs;
  return merged;
}

function intersectGraph(
  a: GraphScope | undefined,
  b: GraphScope | undefined,
): GraphScope | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: GraphScope = {};
  const labels = intersectStringSets(a?.labels, b?.labels, true);
  const relationshipTypes = intersectStringSets(
    a?.relationshipTypes,
    b?.relationshipTypes,
    true,
  );
  const mode = minMode(a?.mode, b?.mode);
  const budget = intersectBudgets(a?.budget, b?.budget);
  if (labels !== undefined) merged.labels = labels;
  if (relationshipTypes !== undefined)
    merged.relationshipTypes = relationshipTypes;
  if (mode !== undefined) merged.mode = mode;
  if (budget !== undefined) merged.budget = budget;
  return merged;
}

/** Extract the mcp rule sets from a scope input (raw or effective). */
function mcpRuleSetsOf(scope: ScopeLike): readonly (readonly McpScopeRule[])[] {
  const mcp = (scope as { mcp?: EffectiveMcpScope | ResourceScope["mcp"] }).mcp;
  if (mcp === undefined) return [];
  if ("ruleSets" in mcp) return mcp.ruleSets;
  return [mcp.rules];
}

/**
 * Intersect two resource scopes dimension-wise — the resulting scope is at
 * most as permissive as either input (narrowing only, never widening):
 *   - labels / relationshipTypes / skills.slugs / agents.refs → set
 *     intersection; undefined (or empty for graph dims) = unrestricted.
 *   - graph.budget → element-wise min.
 *   - graph.mode  → min over read < extend.
 *   - mcp → the union of both sides' rule sets, evaluated together by
 *     evaluateEffectiveMcpScope taking the most restrictive effect.
 */
export function intersectEffectiveScope(
  a: ScopeLike,
  b: ScopeLike,
): EffectiveScope {
  const merged: EffectiveScope = {};

  const graph = intersectGraph(
    (a as ResourceScope).graph,
    (b as ResourceScope).graph,
  );
  if (graph !== undefined) merged.graph = graph;

  const ruleSets = [...mcpRuleSetsOf(a), ...mcpRuleSetsOf(b)];
  if (ruleSets.length > 0) merged.mcp = { ruleSets };

  const aSkills = (a as ResourceScope).skills;
  const bSkills = (b as ResourceScope).skills;
  if (aSkills !== undefined || bSkills !== undefined) {
    const slugs = intersectStringSets(aSkills?.slugs, bSkills?.slugs);
    merged.skills = slugs === undefined ? {} : { slugs };
  }

  const aAgents = (a as ResourceScope).agents;
  const bAgents = (b as ResourceScope).agents;
  if (aAgents !== undefined || bAgents !== undefined) {
    const refs = intersectStringSets(aAgents?.refs, bAgents?.refs);
    merged.agents = refs === undefined ? {} : { refs };
  }

  return merged;
}

/**
 * Evaluate an MCP tool key ("server:tool") against an effective MCP scope.
 * Each contributing rule set is evaluated independently, first-match-wins
 * (glob semantics from packages/mcp-config/src/permissions.ts); a set with no
 * matching rule is unrestricted → allow. The final effect is the most
 * restrictive across all sets: deny > ask > allow.
 */
export function evaluateEffectiveMcpScope(
  scope: EffectiveMcpScope | undefined,
  toolKey: string,
): McpEffect {
  if (scope === undefined || scope.ruleSets.length === 0) return "allow";
  let effective: McpEffect = "allow";
  for (const ruleSet of scope.ruleSets) {
    let setEffect: McpEffect = "allow"; // no match = unrestricted on this side
    for (const rule of ruleSet) {
      if (matchGlob(rule.pattern, toolKey)) {
        setEffect = rule.effect;
        break; // first match wins within a set
      }
    }
    if (MCP_EFFECT_RANK[setEffect] > MCP_EFFECT_RANK[effective])
      effective = setEffect;
  }
  return effective;
}

// ── Agent effective-permission resolution ─────────────────────────────────────

export interface AgentResolveInput {
  /** The agent principal doing the work (iam.principals kind='agent'). */
  agentPrincipal: ResolvedPrincipal;
  /** The human the agent acts for — the delegation ceiling. */
  humanPrincipal: ResolvedPrincipal;
  /** The capability identifier string, e.g. "graph.query". */
  capability: string;
  /** The scope of the invocation — org or workspace. */
  scope: ResolveScope;
  /** Direct grants — may contain rows for BOTH principals; each side's
   * resolution filters by principalId. */
  grants: readonly Grant[];
  roles: readonly Role[];
  roleGrants: readonly RoleGrant[];
  policies: readonly Policy[];
  defaultEffect: CapabilityEffect;
  now?: Date;
  clientIp?: string | null;
  /**
   * For subagent resolution: the parent run's effective scope. Applied as an
   * additional intersection ceiling — a child can only narrow, never widen,
   * what its parent run was allowed to touch.
   */
  parentEffectiveScope?: ScopeLike;
  /**
   * Per-run cache (create with createEffectivePermissionsCache). When the
   * same (agent, human, capability, scope, parent) tuple resolves twice in
   * one run, the cached effective-permissions object is returned.
   */
  cache?: EffectivePermissionsCache;
}

export interface AgentEffectivePermissions {
  /** Deny-wins merge of the agent's and the human's resolution outcomes. */
  outcome: "allow" | "deny" | "pending_approval";
  /** Populated when outcome is "deny". */
  reason?:
    | "no_grant"
    | "workspace_deny"
    | "org_enforced_deny"
    | "expired"
    | "condition_failed";
  /** The intersected resource-scope ceiling for this run. */
  resourceScope: EffectiveScope;
  /** The agent principal's own resolution (with trace). */
  agentResult: ResolveResult;
  /** The invoking human's resolution (with trace). */
  humanResult: ResolveResult;
}

/** Per-run memoization store for resolveAgentEffectivePermissions. */
export type EffectivePermissionsCache = Map<string, AgentEffectivePermissions>;

/** Create a fresh per-run effective-permissions cache. */
export function createEffectivePermissionsCache(): EffectivePermissionsCache {
  return new Map();
}

/**
 * Collect the resourceScope ceilings attached (via conditionsJsonb) to a
 * principal's relevant, active grants for this capability + scope. Multiple
 * scoped grants on one principal intersect (conditions are AND semantics).
 * Returns undefined when the principal carries no resourceScope at all —
 * i.e. unrestricted on that side.
 */
function principalScopeCeiling(
  principalId: string,
  capability: string,
  scope: ResolveScope,
  grants: readonly Grant[],
  evalCtx: ConditionEvalContext,
): EffectiveScope | undefined {
  let ceiling: EffectiveScope | undefined;
  for (const g of grants) {
    if (g.principalId !== principalId) continue;
    if (g.capabilityId !== capability) continue;
    const inScope =
      (g.scopeKind === "workspace" &&
        scope.kind === "workspace" &&
        g.scopeId === scope.workspaceId) ||
      (g.scopeKind === "org" && g.scopeId === scope.orgId);
    if (!inScope) continue;
    if (g.expiresAt && g.expiresAt < evalCtx.now) continue;
    if (!evaluateConditions(g.conditionsJsonb, evalCtx)) continue;
    const raw =
      typeof g.conditionsJsonb === "object" &&
      g.conditionsJsonb !== null &&
      !Array.isArray(g.conditionsJsonb)
        ? (g.conditionsJsonb as Record<string, unknown>)["resourceScope"]
        : undefined;
    if (raw === undefined) continue;
    const parsed = parseResourceScope(raw);
    if (parsed === null) continue; // malformed — already fail-closed by evaluateConditions
    ceiling =
      ceiling === undefined
        ? intersectEffectiveScope(parsed, {})
        : intersectEffectiveScope(ceiling, parsed);
  }
  return ceiling;
}

/** Deny-wins merge of two resolution outcomes: deny > pending_approval > allow. */
function mergeOutcomes(
  a: ResolveResult,
  b: ResolveResult,
): {
  outcome: "allow" | "deny" | "pending_approval";
  reason?: AgentEffectivePermissions["reason"];
} {
  if (a.outcome === "deny") return { outcome: "deny", reason: a.reason };
  if (b.outcome === "deny") return { outcome: "deny", reason: b.reason };
  if (a.outcome === "pending_approval" || b.outcome === "pending_approval") {
    return { outcome: "pending_approval" };
  }
  return { outcome: "allow" };
}

/**
 * Resolve the effective permissions of an agent principal acting for a human.
 *
 * Delegation ceiling: the agent's effective outcome is the deny-wins
 * intersection of its own resolution and the invoking human's resolution —
 * an agent can never exceed the human it acts for. The effective
 * resourceScope is the dimension-wise intersection of the agent's scope
 * ceiling, the human's scope ceiling, and (for subagents) the parent run's
 * effective scope. Pure — all data is pre-fetched by the caller. Results are
 * memoized in the supplied per-run cache.
 */
export function resolveAgentEffectivePermissions(
  input: AgentResolveInput,
): AgentEffectivePermissions {
  const cacheKey =
    input.cache !== undefined
      ? [
          input.agentPrincipal.id,
          input.humanPrincipal.id,
          input.capability,
          input.scope.kind,
          input.scope.orgId,
          input.scope.workspaceId ?? "",
          JSON.stringify(input.parentEffectiveScope ?? null),
        ].join("\u0000")
      : null;
  if (cacheKey !== null) {
    const hit = input.cache!.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  const now = input.now ?? new Date();
  const evalCtx: ConditionEvalContext = {
    now,
    clientIp: input.clientIp ?? null,
  };

  const common = {
    capability: input.capability,
    scope: input.scope,
    grants: input.grants,
    roles: input.roles,
    roleGrants: input.roleGrants,
    policies: input.policies,
    defaultEffect: input.defaultEffect,
    now,
    clientIp: input.clientIp,
  };

  const agentResult = resolve({ ...common, principal: input.agentPrincipal });
  const humanResult = resolve({ ...common, principal: input.humanPrincipal });

  const merged = mergeOutcomes(agentResult, humanResult);

  // Intersect scope ceilings: agent's grants ∩ human's grants ∩ parent run.
  const agentScope = principalScopeCeiling(
    input.agentPrincipal.id,
    input.capability,
    input.scope,
    input.grants,
    evalCtx,
  );
  const humanScope = principalScopeCeiling(
    input.humanPrincipal.id,
    input.capability,
    input.scope,
    input.grants,
    evalCtx,
  );

  let resourceScope: EffectiveScope = {};
  if (agentScope !== undefined)
    resourceScope = intersectEffectiveScope(resourceScope, agentScope);
  if (humanScope !== undefined)
    resourceScope = intersectEffectiveScope(resourceScope, humanScope);
  if (input.parentEffectiveScope !== undefined) {
    resourceScope = intersectEffectiveScope(
      resourceScope,
      input.parentEffectiveScope,
    );
  }

  const result: AgentEffectivePermissions = {
    outcome: merged.outcome,
    ...(merged.reason !== undefined ? { reason: merged.reason } : {}),
    resourceScope,
    agentResult,
    humanResult,
  };

  if (cacheKey !== null) input.cache!.set(cacheKey, result);
  return result;
}
