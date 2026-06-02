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
//   Rule 8: Default effect (contract) → use contract.defaultEffect

import type { CapabilityEffect, ResolvedPrincipal } from "../types";

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
      reason: "no_grant" | "workspace_deny" | "org_enforced_deny" | "expired" | "condition_failed";
      trace: Trace;
    }
  | { outcome: "pending_approval"; trace: Trace };

export interface ResolveInput {
  /** The principal whose access is being evaluated. */
  principal: ResolvedPrincipal;
  /** The capability identifier string, e.g. "organization.create". */
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExpired(g: Grant): boolean {
  if (!g.expiresAt) return false;
  return g.expiresAt < new Date();
}

/**
 * Evaluate conditions_jsonb against the invocation context. Currently a
 * strict equality check on each key in the conditions object. Extend this
 * function as the condition language grows.
 *
 * Returns true when all conditions are satisfied (or there are none).
 */
function conditionsMet(grant: Grant): boolean {
  const conditions = grant.conditionsJsonb;
  if (conditions === null || conditions === undefined) return true;
  // Conditions must be a plain object; anything else fails closed.
  if (typeof conditions !== "object" || Array.isArray(conditions)) return false;
  // Future: evaluate IP ranges, time windows, etc. For now all non-empty
  // conditions objects fail — the condition language is not yet specified.
  // An empty conditions object means "always satisfied".
  const keys = Object.keys(conditions as Record<string, unknown>);
  return keys.length === 0;
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

  const steps: TraceStep[] = [];

  // Filter grants to those relevant to this (principal, capability, scope).
  const relevantGrants = grants.filter(
    (g) =>
      g.principalId === principal.id &&
      g.capabilityId === capability &&
      g.scopeKind === scope.kind &&
      (scope.kind === "org"
        ? g.scopeId === scope.orgId
        : g.scopeId === scope.workspaceId),
  );

  // Helper: split grants by scope_kind for rules 1-6.
  const workspaceGrants = relevantGrants.filter((g) => g.scopeKind === "workspace");
  const orgGrants = relevantGrants.filter((g) => g.scopeKind === "org");

  // Org enforced policies (rules 2, 4) apply regardless of the invocation's scope_kind —
  // an org enforced deny is a hard stop that cannot be overridden by a workspace grant.
  // We therefore filter org policies separately from the scope filter.
  const orgEnforcedDenyPolicies = policies.filter(
    (p) =>
      p.capabilityId === capability &&
      p.enforced &&
      p.effect === "deny" &&
      p.scopeKind === "org" &&
      (p.scopeId === scope.orgId || p.scopeId === null || p.scopeId === undefined),
  );
  const orgEnforcedAllowPolicies = policies.filter(
    (p) =>
      p.capabilityId === capability &&
      p.enforced &&
      p.effect === "allow" &&
      p.scopeKind === "org" &&
      (p.scopeId === scope.orgId || p.scopeId === null || p.scopeId === undefined),
  );

  // ── Rule 1: Workspace explicit deny ────────────────────────────────────────
  const wsDenyGrant = scope.kind === "workspace"
    ? workspaceGrants.find((g) => g.effect === "deny" && !isExpired(g) && conditionsMet(g))
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
  steps.push({ rule: "1:workspace_deny", description: "No workspace deny grant", decided: false });

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
      (g) => g.effect === "allow" && !isExpired(g) && conditionsMet(g),
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
    const wsExpiredGrant = workspaceGrants.find((g) => g.effect === "allow" && isExpired(g));
    if (wsExpiredGrant) {
      const step: TraceStep = {
        rule: "3:workspace_allow",
        description: "Workspace allow grant found but expired",
        decided: true,
        outcome: "deny",
      };
      steps.push(step);
      return { outcome: "deny", reason: "expired", trace: { steps, decidedBy: step } };
    }
    const wsConditionFailed = workspaceGrants.find(
      (g) => g.effect === "allow" && !isExpired(g) && !conditionsMet(g),
    );
    if (wsConditionFailed) {
      const step: TraceStep = {
        rule: "3:workspace_allow",
        description: "Workspace allow grant found but condition failed",
        decided: true,
        outcome: "deny",
      };
      steps.push(step);
      return { outcome: "deny", reason: "condition_failed", trace: { steps, decidedBy: step } };
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
      (g) => g.effect === "require_approval" && !isExpired(g) && conditionsMet(g),
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
  const orgAllowGrant = orgGrants.find(
    (g) => g.effect === "allow" && !isExpired(g) && conditionsMet(g),
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
    (g) => g.effect === "require_approval" && !isExpired(g) && conditionsMet(g),
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
  const orgDenyGrant = orgGrants.find(
    (g) => g.effect === "deny" && !isExpired(g) && conditionsMet(g),
  );
  if (orgDenyGrant) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org deny grant inherited",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return { outcome: "deny", reason: "no_grant", trace: { steps, decidedBy: step } };
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
    return { outcome: "deny", reason: "expired", trace: { steps, decidedBy: step } };
  }
  // Check condition-failed org grants.
  const orgConditionFailed = orgGrants.find((g) => !conditionsMet(g));
  if (orgConditionFailed) {
    const step: TraceStep = {
      rule: "6:org_grant",
      description: "Org grant found but condition failed",
      decided: true,
      outcome: "deny",
    };
    steps.push(step);
    return { outcome: "deny", reason: "condition_failed", trace: { steps, decidedBy: step } };
  }
  steps.push({ rule: "6:org_grant", description: "No org grant found", decided: false });

  // ── Rule 7: Role-inherited grant ───────────────────────────────────────────
  // Find all roles this principal is a member of.
  const principalRoles = roles.filter((r) => r.principalIds.includes(principal.id));
  const principalRoleIds = principalRoles.map((r) => r.id);

  // Find role grants for this capability from the principal's roles.
  const matchingRoleGrants = roleGrants.filter(
    (rg) => principalRoleIds.includes(rg.roleId) && rg.capabilityId === capability,
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
  const roleApprovalGrant = matchingRoleGrants.find((rg) => rg.effect === "require_approval");
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
    return { outcome: "deny", reason: "no_grant", trace: { steps, decidedBy: step } };
  }
  steps.push({ rule: "7:role_grant", description: "No matching role grant", decided: false });

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
    return { outcome: "pending_approval", trace: { steps, decidedBy: defaultStep } };
  }
  return { outcome: "deny", reason: "no_grant", trace: { steps, decidedBy: defaultStep } };
}
