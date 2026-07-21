// agent-run.ts — per-run agent IAM resolution cache (Agent RBAC Phase 2,
// docs/specs/agent-rbac/spec.md §3.4/§3.5).
//
// An agent run resolves its effective permissions ONCE — the delegation
// ceiling (agent principal ∩ invoking human, deny-wins) computed from one
// pre-fetched authz snapshot — and every consumer reads THE SAME object:
//
//   - kernel invoke() (packages/oxagen/src/kernel.ts → checkIAM's agent
//     branch in packages/iam/src/check-iam.ts) — the real gate, and
//   - tool materialization (packages/agent/src/runtime/materialize-tools.ts,
//     Phase 2's second seam) — the UX filter,
//
// so the two layers can never diverge into two policies (§3.5: "Both layers
// read one resolution, computed once per run and cached on the run context").
//
// The cache lives ON the run context object (`AgentRunIAMContext.resolution`),
// never in module state: runs are concurrent, and a module-global cache would
// bleed one run's grants into another. The impure snapshot fetch lives in
// packages/iam/src/fetch-agent-authz.ts; this module is pure (no I/O) like the
// rest of @oxagen/oxagen/iam.

import type { CapabilityEffect, ResolvedPrincipal } from "../types";
// Type-only — erased at compile time, so no runtime cycle with agent-schema.
import type { GraphAccess } from "../agent-schema";
import {
  resolveAgentEffectivePermissions,
  type EffectivePermissions,
  type EffectiveResourceScope,
  type Grant,
  type Policy,
  type ResolveScope,
  type Role,
  type RoleGrant,
} from "./resolve";

/**
 * The pre-fetched IAM data an agent run resolves against: every role in the
 * org, the role memberships of BOTH principals (agent + invoking human), and
 * the role-grants of every org role across ALL capabilities — unfiltered by
 * capability, because one snapshot must serve every capability the run may
 * touch (kernel checks and the tool-materialization allowlist alike).
 */
export interface AgentAuthzSnapshot {
  readonly grants: readonly Grant[];
  readonly roles: readonly Role[];
  readonly roleGrants: readonly RoleGrant[];
  readonly policies: readonly Policy[];
}

/**
 * The once-per-run resolution object. `snapshot` is the raw authz data;
 * `byCapability` memoizes the per-capability delegation-ceiling result so a
 * second invoke() of the same capability in the same run is a Map lookup.
 */
export interface AgentRunIAMResolution {
  readonly snapshot: AgentAuthzSnapshot;
  /** Memoized per-capability effective permissions (agent ∩ human, deny-wins). */
  readonly byCapability: Map<string, EffectivePermissions>;
  /** When the snapshot was fetched — a run's resolution is never refreshed. */
  readonly resolvedAt: Date;
}

/**
 * The agent-run IAM context a CapabilityContext carries when a capability is
 * invoked from an agent run. Mirrors @oxagen/iam's AgentRunAuthzContext
 * (agentPrincipal + humanPrincipal + principalKind discriminator) and adds
 * run lineage (agentId/runId/parentRunId, audit spec §5) plus the mutable
 * per-run `resolution` cache slot.
 *
 * Everything except `resolution` is readonly — the identity of a run never
 * changes mid-run. `resolution` is written exactly once, by the first IAM
 * check of the run, and read by every later check and by tool
 * materialization.
 */
export interface AgentRunIAMContext {
  /** Discriminator — an agent run's context is always kind "agent". */
  readonly principalKind: "agent";
  /** The deployed agent's own delegated IAM principal. */
  readonly agentPrincipal: ResolvedPrincipal;
  /**
   * The invoking human principal (the delegation ceiling). Null when no
   * delegating human could be resolved — the human side of the intersection
   * then resolves as an unprivileged sentinel principal (no roles, no
   * grants), i.e. it contributes each capability's contract defaultEffect.
   * Fail-closed by construction: a missing delegator never widens access.
   */
  readonly humanPrincipal: ResolvedPrincipal | null;
  /** Agent public id (agt_…) — recorded on every audit row (spec §5). */
  readonly agentId: string;
  /** The run this invocation belongs to — audit correlation id. */
  readonly runId: string;
  /** Parent run for subagent dispatches; null/absent for top-level runs. */
  readonly parentRunId?: string | null;
  /**
   * The parent run's already-resolved effective resourceScope, set by the
   * dispatch/bridge path that created this child context (subagent executor,
   * A2A inbound). When present it is an ADDITIONAL ceiling on every
   * resolution — the resolver intersects it dimension-wise, so a child can
   * only narrow, never widen, its parent's scope (spec §0/§3.3). Absent for
   * top-level runs.
   */
  readonly parentEffectiveScope?: EffectiveResourceScope;
  /**
   * The agent DEFINITION's `graphAccess` declaration (agent-schema.ts),
   * populated by the run driver from the deployed definition version when the
   * run context is constructed. Phase 3 (spec §3.6) intersects this — the
   * *request* — with the role ceiling (`resolution`'s resourceScope.graph) to
   * produce the effective GraphScope every ontology / semantic graph query
   * runs under. Absent ⇒ the declaration contributes no restriction (the role
   * ceiling alone applies); a missing declaration can never widen access
   * because the ceiling still binds.
   */
  readonly graphAccess?: GraphAccess;
  /**
   * Per-run resolution cache. Written by the first kernel IAM check of the
   * run (packages/iam/src/check-iam.ts); read by every subsequent invoke()
   * and by tool materialization. Cached HERE — on the run context object —
   * deliberately: runs are concurrent, so module-global state is forbidden.
   */
  resolution?: AgentRunIAMResolution;
}

/**
 * Sentinel principal used for the human side of the intersection when the run
 * carries no resolvable delegating human. Matches the all-zero sentinel
 * checkIAM already substitutes for an unresolved principal: it belongs to no
 * roles and holds no grants, so its resolution falls through to each
 * capability's contract defaultEffect (rule 8) — the most restrictive ceiling
 * we can compute without a real delegator.
 */
export const SENTINEL_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";

/** Wrap a fetched snapshot into a fresh, empty-memo resolution object. */
export function createAgentRunResolution(
  snapshot: AgentAuthzSnapshot,
): AgentRunIAMResolution {
  return {
    snapshot,
    byCapability: new Map<string, EffectivePermissions>(),
    resolvedAt: new Date(),
  };
}

export interface ResolveAgentRunCapabilityArgs {
  capability: string;
  scope: ResolveScope;
  defaultEffect: CapabilityEffect;
  now?: Date;
  clientIp?: string | null;
}

/**
 * Resolve one capability for an agent run against the run's cached snapshot,
 * memoized per capability on `resolution.byCapability`.
 *
 * Memoization is keyed by capability name alone — sound because everything
 * else is run-constant: the scope (a run is pinned to one org+workspace), the
 * defaultEffect (a property of the capability's contract), and the snapshot
 * itself (fetched once per run, never refreshed). `now`/`clientIp` feed
 * grant-condition evaluation on the FIRST resolution of each capability; a
 * run reuses that decision rather than re-evaluating time windows mid-run —
 * the same "one resolution per run" contract §3.5 mandates.
 */
export function resolveAgentRunCapability(
  runCtx: AgentRunIAMContext,
  resolution: AgentRunIAMResolution,
  args: ResolveAgentRunCapabilityArgs,
): EffectivePermissions {
  const cached = resolution.byCapability.get(args.capability);
  if (cached !== undefined) return cached;

  const humanPrincipal: ResolvedPrincipal = runCtx.humanPrincipal ?? {
    id: SENTINEL_PRINCIPAL_ID,
    kind: "service",
    orgId: runCtx.agentPrincipal.orgId,
    workspaceId: runCtx.agentPrincipal.workspaceId,
  };

  const permissions = resolveAgentEffectivePermissions({
    agentPrincipal: runCtx.agentPrincipal,
    humanPrincipal,
    capability: args.capability,
    scope: args.scope,
    grants: resolution.snapshot.grants,
    roles: resolution.snapshot.roles,
    roleGrants: resolution.snapshot.roleGrants,
    policies: resolution.snapshot.policies,
    defaultEffect: args.defaultEffect,
    now: args.now,
    clientIp: args.clientIp,
    // Subagent/A2A narrowing (spec §2.7): the parent run's effective scope is
    // an additional ceiling — intersected dimension-wise by the resolver, so
    // this child resolution can only narrow, never widen, the parent's scope.
    parentEffectiveScope: runCtx.parentEffectiveScope,
  });

  resolution.byCapability.set(args.capability, permissions);
  return permissions;
}
