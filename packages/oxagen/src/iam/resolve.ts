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
  type ConditionEvalContext,
  type GraphScope,
  type GraphScopeBudget,
  type GraphScopeMode,
  type McpRule,
  type McpRuleEffect,
  type McpScope,
  type SkillsScope,
  type AgentsScope,
  type ResourceScopeCondition,
} from "./conditions";

export type {
  GraphScope,
  GraphScopeBudget,
  GraphScopeMode,
  McpRule,
  McpRuleEffect,
  McpScope,
  SkillsScope,
  AgentsScope,
  ResourceScopeCondition,
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
  /**
   * Optional conditions payload (same conditionsJsonb shape as Grant). Used
   * for the agent-RBAC resourceScope ceiling — role_grants carry the scope,
   * not just an effect. Absent on rows that predate resourceScope.
   */
  conditionsJsonb?: unknown;
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

  // Effects are evaluated most-restrictive first: deny → require_approval →
  // allow. `matchingRoleGrants` spans EVERY role the principal belongs to, so a
  // principal in two roles can hold conflicting effects for one capability. If
  // `allow` were checked first, an explicit deny grant would be unreachable
  // whenever any other role also granted allow — silently voiding the deny.
  //
  // This ordering is what the Rule 7.5 comment below already assumes when it
  // states that rules 1, 2, 6 and 7 "all run first and hard-stop, so an owner
  // CAN restrict themselves through config", and it matches the deny-first
  // ordering rules 1–3 apply at the workspace tier.
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

// ═════════════════════════════════════════════════════════════════════════════
// Agent RBAC — delegation-ceiling resolution (OXA agent-rbac, Phase 1)
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above this line is the original single-principal resolver,
// unchanged. The functions below let a caller resolve an AGENT principal's
// effective permissions as the intersection of:
//   (a) the agent principal's own grants/roles, and
//   (b) the invoking human's grants/roles (the delegation ceiling — an agent
//       can never exceed the human it acts for),
// and, for a subagent dispatch, further narrow by the parent run's already-
// resolved effective scope.
//
// The result is ONE object: EffectivePermissions. It is meant to be computed
// once per run and cached on the run context (§3.5 of the spec — kernel
// invoke() and tool materialization both read the same resolution, never two
// divergent policies).

/** Outcome ordering for deny-wins merges (higher = more restrictive). */
const OUTCOME_RANK: Record<"allow" | "pending_approval" | "deny", number> = {
  allow: 0,
  pending_approval: 1,
  deny: 2,
};

/** Merge two capability outcomes: deny > pending_approval > allow. */
function mergeOutcome(
  a: "allow" | "pending_approval" | "deny",
  b: "allow" | "pending_approval" | "deny",
): "allow" | "pending_approval" | "deny" {
  return OUTCOME_RANK[a] >= OUTCOME_RANK[b] ? a : b;
}

function outcomeOf(
  result: ResolveResult,
): "allow" | "pending_approval" | "deny" {
  return result.outcome;
}

/**
 * Simple glob matcher for "server:tool" MCP patterns — "*" matches anything,
 * a literal segment matches exactly. Deliberately re-implemented (rather than
 * imported) to keep this package dependency-free; semantics are identical to
 * packages/mcp-config/src/permissions.ts `matchGlob`.
 */
function matchGlobPattern(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = `^${escaped.replace(/\*/g, ".*")}$`;
  try {
    return new RegExp(regexStr).test(value);
  } catch {
    return false;
  }
}

/** Rank for "most restrictive wins" MCP effect merges: deny > ask > allow. */
const MCP_EFFECT_RANK: Record<McpRuleEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Evaluate one rule set (first-match-wins) for a "server:tool" key.
 * Absent/empty rules → "allow" (unrestricted — matches the "undefined =
 * unrestricted" convention used across every other resourceScope dimension).
 */
export function evaluateMcpRules(
  rules: readonly McpRule[],
  serverTool: string,
): McpRuleEffect {
  for (const rule of rules) {
    if (matchGlobPattern(rule.pattern, serverTool)) return rule.effect;
  }
  return "allow";
}

/**
 * Evaluate an EffectiveMcpScope (independently-evaluated rule sets from every
 * contributing ceiling) for a "server:tool" key and return the single most
 * restrictive decision across all sets (deny > ask > allow).
 */
export function evaluateEffectiveMcpScope(
  scope: EffectiveMcpScope | undefined,
  serverTool: string,
): McpRuleEffect {
  if (!scope || scope.ruleSets.length === 0) return "allow";
  let result: McpRuleEffect = "allow";
  for (const rules of scope.ruleSets) {
    const decision = evaluateMcpRules(rules, serverTool);
    if (MCP_EFFECT_RANK[decision] > MCP_EFFECT_RANK[result]) result = decision;
  }
  return result;
}

/**
 * Build the canonical "server:tool" key every MCP rule evaluation uses
 * (Phase 4a, spec §3.7). The server segment is lowercased so rule authors
 * address servers by their lowercase name (the seeded system-role convention,
 * e.g. "github:*") regardless of the display-cased server row name
 * ("GitHub"). Tool names pass through verbatim — MCP tools are snake_case by
 * convention and matched case-sensitively.
 */
export function mcpServerToolKey(serverName: string, toolName: string): string {
  return `${serverName.toLowerCase()}:${toolName}`;
}

/**
 * Does this rule pattern decide EVERY tool of `serverName`? Exact, not
 * conservative: a glob pattern P matches "s:t" for ALL tool strings t iff P
 * ends in "*" (so the tail wildcard can absorb any tool name) and P matches
 * the bare "s:" prefix (take t = "" for one direction; the trailing ".*" in
 * the compiled regex absorbs any longer t for the other).
 */
function mcpRuleDecidesAllTools(pattern: string, serverName: string): boolean {
  return pattern.endsWith("*") && matchGlobPattern(pattern, serverName + ":");
}

/**
 * Could this rule pattern match SOME tool of `serverName`? Deliberately
 * conservative in the "yes" direction: over-reporting keeps a server in the
 * binding, where the per-tool-call gate (the authoritative enforcement)
 * still evaluates every invocation — it can never widen access.
 */
function mcpRuleCouldMatchServer(pattern: string, serverName: string): boolean {
  if (mcpRuleDecidesAllTools(pattern, serverName)) return true;
  const idx = pattern.indexOf(":");
  if (idx >= 0) {
    // "server-glob:tool-glob" — the rule addresses this server iff the
    // server segment matches. (A '*' inside the server segment could in
    // principle also absorb the ':' — matchGlobPattern on the segment is the
    // conservative approximation.)
    return matchGlobPattern(pattern.slice(0, idx), serverName);
  }
  // No ':' in the pattern: it can only match a "server:tool" key when a '*'
  // absorbs the ':' — patterns ending in '*' were handled above, so only
  // internal-star shapes remain. Treat any remaining starred pattern as
  // could-match (conservative); a literal pattern without ':' can never
  // match a key that always contains ':'.
  return pattern.includes("*");
}

/**
 * True when ONE rule set (first-match-wins) provably denies EVERY tool of
 * `serverName`: walking the rules in order, a deny rule that decides all
 * tools is reached before any non-deny rule that could match some tool of
 * this server. The default effect for unmatched tools is "allow", so a rule
 * set without a covering deny never fully denies a server.
 */
export function mcpRuleSetFullyDeniesServer(
  rules: readonly McpRule[],
  serverName: string,
): boolean {
  const server = serverName.toLowerCase();
  for (const rule of rules) {
    if (rule.effect !== "deny") {
      if (mcpRuleCouldMatchServer(rule.pattern, server)) return false;
      continue;
    }
    if (mcpRuleDecidesAllTools(rule.pattern, server)) return true;
    // A partial deny (e.g. "github:delete_*") leaves other tools undecided —
    // keep walking.
  }
  return false;
}

/**
 * True when the effective (intersected) MCP scope denies EVERY tool of
 * `serverName` — i.e. ANY contributing ceiling's rule set fully denies it
 * (the cross-set combination is most-restrictive-wins, so one fully-denying
 * ceiling denies every tool regardless of the other sets). Used by the agent
 * binding (apply-agent-binding.ts) to drop fully-denied servers from the
 * per-turn MCP server allowlist entirely; `undefined` scope = unrestricted.
 */
export function mcpServerFullyDenied(
  scope: EffectiveMcpScope | undefined,
  serverName: string,
): boolean {
  if (!scope) return false;
  return scope.ruleSets.some((rules) =>
    mcpRuleSetFullyDeniesServer(rules, serverName),
  );
}

// ── Effective scope types (exported for downstream consumers: kernel,
//    packages/ontology, tool materialization, MCP binding) ─────────────────────

/**
 * MCP dimension of an effective (post-intersection) scope. Unlike the other
 * dimensions, MCP rule sets cannot be flattened into one list without losing
 * "first-match-wins" semantics per contributing ceiling, so each contributing
 * ceiling's rule list is kept separate and evaluated independently per call
 * (evaluateEffectiveMcpScope), then combined by most-restrictive-effect.
 */
export interface EffectiveMcpScope {
  ruleSets: ReadonlyArray<readonly McpRule[]>;
}

/**
 * The fully-resolved, intersected resource-scope ceiling for a principal (or
 * a delegation chain of principals). `undefined` on any dimension/field means
 * "unrestricted on that axis" — the same convention as the raw condition
 * payload. This is the shape every downstream consumer (kernel, ontology
 * scopedSession, tool materialization, MCP binding) should read.
 */
export interface EffectiveResourceScope {
  graph?: GraphScope;
  mcp?: EffectiveMcpScope;
  skills?: SkillsScope;
  agents?: AgentsScope;
}

/** Intersect two optional string-set dimensions. undefined = unrestricted. */
function intersectStringSets(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  const bSet = new Set(b);
  return a.filter((x) => bSet.has(x));
}

const GRAPH_MODE_RANK: Record<GraphScopeMode, number> = { read: 0, extend: 1 };

/** Take the more restrictive (lower-ranked) of two optional graph modes. */
function minGraphMode(
  a: GraphScopeMode | undefined,
  b: GraphScopeMode | undefined,
): GraphScopeMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return GRAPH_MODE_RANK[a] <= GRAPH_MODE_RANK[b] ? a : b;
}

/** Element-wise min of two optional numeric budget ceilings. undefined = no ceiling. */
function minOptional(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function intersectBudget(
  a: GraphScopeBudget | undefined,
  b: GraphScopeBudget | undefined,
): GraphScopeBudget | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: GraphScopeBudget = {
    maxHops: minOptional(a?.maxHops, b?.maxHops),
    maxNodes: minOptional(a?.maxNodes, b?.maxNodes),
    maxTraversalMs: minOptional(a?.maxTraversalMs, b?.maxTraversalMs),
  };
  // Drop keys that are undefined so the object matches "absent ceiling" cleanly.
  const cleaned: GraphScopeBudget = {};
  if (merged.maxHops !== undefined) cleaned.maxHops = merged.maxHops;
  if (merged.maxNodes !== undefined) cleaned.maxNodes = merged.maxNodes;
  if (merged.maxTraversalMs !== undefined)
    cleaned.maxTraversalMs = merged.maxTraversalMs;
  return cleaned;
}

/**
 * Intersect two optional GraphScope ceilings (labels/rel-types set-intersect,
 * mode min, budget element-wise min). Exported for the ONE shared
 * effective-scope computation downstream (role ceiling ∩ agent `graphAccess`
 * declaration, spec §3.3/§3.6) — packages/handlers' effectiveGraphScope helper.
 * Do not reimplement this intersection anywhere else.
 */
export function intersectGraphScope(
  a: GraphScope | undefined,
  b: GraphScope | undefined,
): GraphScope | undefined {
  if (a === undefined && b === undefined) return undefined;
  const scope: GraphScope = {};
  const labels = intersectStringSets(a?.labels, b?.labels);
  if (labels !== undefined) scope.labels = labels;
  const relationshipTypes = intersectStringSets(
    a?.relationshipTypes,
    b?.relationshipTypes,
  );
  if (relationshipTypes !== undefined)
    scope.relationshipTypes = relationshipTypes;
  const mode = minGraphMode(a?.mode, b?.mode);
  if (mode !== undefined) scope.mode = mode;
  const budget = intersectBudget(a?.budget, b?.budget);
  if (budget !== undefined) scope.budget = budget;
  return scope;
}

function intersectMcpScope(
  a: EffectiveMcpScope | undefined,
  b: EffectiveMcpScope | undefined,
): EffectiveMcpScope | undefined {
  const ruleSets = [...(a?.ruleSets ?? []), ...(b?.ruleSets ?? [])];
  if (ruleSets.length === 0) return undefined;
  return { ruleSets };
}

function intersectSkillsScope(
  a: SkillsScope | undefined,
  b: SkillsScope | undefined,
): SkillsScope | undefined {
  if (a === undefined && b === undefined) return undefined;
  const slugs = intersectStringSets(a?.slugs, b?.slugs);
  return slugs === undefined ? {} : { slugs };
}

function intersectAgentsScope(
  a: AgentsScope | undefined,
  b: AgentsScope | undefined,
): AgentsScope | undefined {
  if (a === undefined && b === undefined) return undefined;
  const refs = intersectStringSets(a?.refs, b?.refs);
  return refs === undefined ? {} : { refs };
}

/**
 * Intersect two EffectiveResourceScope ceilings dimension-wise. This is the
 * one narrowing operation used everywhere a ceiling gets combined with
 * another: agent ∩ human (delegation), parent-run ∩ child config (subagent
 * narrowing), and role ∩ per-agent config (declared elsewhere, same rule).
 */
export function intersectEffectiveScope(
  a: EffectiveResourceScope | undefined,
  b: EffectiveResourceScope | undefined,
): EffectiveResourceScope {
  if (a === undefined && b === undefined) return {};
  const scope: EffectiveResourceScope = {};
  const graph = intersectGraphScope(a?.graph, b?.graph);
  if (graph !== undefined) scope.graph = graph;
  const mcp = intersectMcpScope(a?.mcp, b?.mcp);
  if (mcp !== undefined) scope.mcp = mcp;
  const skills = intersectSkillsScope(a?.skills, b?.skills);
  if (skills !== undefined) scope.skills = skills;
  const agents = intersectAgentsScope(a?.agents, b?.agents);
  if (agents !== undefined) scope.agents = agents;
  return scope;
}

/** Convert a raw resourceScope condition into an EffectiveResourceScope shell. */
function toEffectiveScope(
  condition: ResourceScopeCondition,
): EffectiveResourceScope {
  const scope: EffectiveResourceScope = {};
  if (condition.graph !== undefined) scope.graph = condition.graph;
  if (condition.mcp !== undefined)
    scope.mcp = { ruleSets: [condition.mcp.rules] };
  if (condition.skills !== undefined) scope.skills = condition.skills;
  if (condition.agents !== undefined) scope.agents = condition.agents;
  return scope;
}

/**
 * Collect every resourceScope ceiling attached to a principal's relevant
 * grants and role-grants (any effect — a ceiling is metadata riding on the
 * grant row, not itself an allow/deny signal), then intersect them all down
 * to one EffectiveResourceScope. A malformed resourceScope payload on any
 * contributing row is skipped (fail-closed on evaluation already happened in
 * evaluateConditions/checkIAM for the grant's allow/deny effect; here we are
 * only extracting the ceiling, so an unparsable payload contributes no
 * further restriction rather than crashing resolution).
 */
function collectResourceScope(
  principalId: string,
  grants: readonly Grant[],
  roles: readonly Role[],
  roleGrants: readonly RoleGrant[],
): EffectiveResourceScope {
  let scope: EffectiveResourceScope = {};

  for (const g of grants) {
    if (g.principalId !== principalId) continue;
    const parsed = parseResourceScope(
      (g.conditionsJsonb as Record<string, unknown> | null | undefined)?.[
        "resourceScope"
      ],
    );
    if (parsed)
      scope = intersectEffectiveScope(scope, toEffectiveScope(parsed));
  }

  const principalRoleIds = new Set(
    roles.filter((r) => r.principalIds.includes(principalId)).map((r) => r.id),
  );
  for (const rg of roleGrants) {
    if (!principalRoleIds.has(rg.roleId)) continue;
    const parsed = parseResourceScope(
      (rg.conditionsJsonb as Record<string, unknown> | null | undefined)?.[
        "resourceScope"
      ],
    );
    if (parsed)
      scope = intersectEffectiveScope(scope, toEffectiveScope(parsed));
  }

  return scope;
}

/**
 * Input for resolving an agent principal's effective permissions. Both the
 * agent's own IAM data AND the invoking human's IAM data must be supplied —
 * the delegation ceiling is computed by intersecting the two independent
 * resolutions.
 */
export interface ResolveAgentInput {
  /** The agent principal itself (kind must be "agent"). */
  agentPrincipal: ResolvedPrincipal;
  /** The human principal this agent run is acting on behalf of. */
  humanPrincipal: ResolvedPrincipal;
  capability: string;
  scope: ResolveScope;
  /** All grants relevant to either principal, pre-fetched by the caller. */
  grants: readonly Grant[];
  roles: readonly Role[];
  roleGrants: readonly RoleGrant[];
  policies: readonly Policy[];
  defaultEffect: CapabilityEffect;
  now?: Date;
  clientIp?: string | null;
  /**
   * The parent run's already-resolved effective scope, when this resolution
   * is for a dispatched subagent. Applied as an ADDITIONAL ceiling — narrowing
   * only, never widening (§3.6/§4 Phase 3 of the spec). Absent for a top-level
   * (non-subagent) agent run.
   */
  parentEffectiveScope?: EffectiveResourceScope;
}

/**
 * One cached-per-run effective-permissions object for an agent principal.
 * `capability` is the single-capability outcome (deny-wins merge of the
 * agent's own resolution and the invoking human's resolution); `resourceScope`
 * is the fully-intersected ceiling (agent ∩ human ∩ optional parent-run
 * scope). Callers resolve once per run and cache this object — see §3.5.
 */
export interface EffectivePermissions {
  outcome: "allow" | "pending_approval" | "deny";
  agentResolution: ResolveResult;
  humanResolution: ResolveResult;
  resourceScope: EffectiveResourceScope;
}

/**
 * Resolve an agent principal's effective permissions for one capability
 * invocation: the delegation ceiling (agent ∩ human) plus, when dispatched
 * as a subagent, a further ceiling from the parent run's already-resolved
 * scope.
 *
 * Both principals are resolved independently through the ordinary `resolve`
 * pipeline (each sees only its own grants/roles/policies, matched by
 * principalId), then combined:
 *   - capability outcome: deny-wins merge of the two outcomes.
 *   - resourceScope: dimension-wise intersection of both principals'
 *     collected ceilings, further intersected with parentEffectiveScope
 *     when present (narrowing only).
 */
export function resolveAgentEffectivePermissions(
  input: ResolveAgentInput,
): EffectivePermissions {
  const {
    agentPrincipal,
    humanPrincipal,
    capability,
    scope,
    grants,
    roles,
    roleGrants,
    policies,
    defaultEffect,
    now,
    clientIp,
    parentEffectiveScope,
  } = input;

  const agentResolution = resolve({
    principal: agentPrincipal,
    capability,
    scope,
    grants,
    roles,
    roleGrants,
    policies,
    defaultEffect,
    now,
    clientIp,
  });

  const humanResolution = resolve({
    principal: humanPrincipal,
    capability,
    scope,
    grants,
    roles,
    roleGrants,
    policies,
    defaultEffect,
    now,
    clientIp,
  });

  const outcome = mergeOutcome(
    outcomeOf(agentResolution),
    outcomeOf(humanResolution),
  );

  const agentScope = collectResourceScope(
    agentPrincipal.id,
    grants,
    roles,
    roleGrants,
  );
  const humanScope = collectResourceScope(
    humanPrincipal.id,
    grants,
    roles,
    roleGrants,
  );
  let resourceScope = intersectEffectiveScope(agentScope, humanScope);
  if (parentEffectiveScope !== undefined) {
    resourceScope = intersectEffectiveScope(
      resourceScope,
      parentEffectiveScope,
    );
  }

  return { outcome, agentResolution, humanResolution, resourceScope };
}
