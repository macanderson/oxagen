// agent-run.ts — the PINNED grant ceiling and the LIVE deny check for a
// governed agent run (docs/specs/run-evidence-ingress/spec.md §"Security and
// retention rules"; 02-run-attempt-foundation-plan.md Task 5; Agent RBAC
// docs/specs/agent-rbac/spec.md §3.4/§3.5).
//
// ── What replaced what ──────────────────────────────────────────────────────
//
// This module used to hold a once-per-run, never-refreshed resolution cache
// (`AgentRunIAMContext.resolution`): the first IAM check of a run fetched a
// snapshot, resolved a capability, memoized the outcome by capability name,
// and every later operation in the run reused it verbatim. That is exactly the
// cache the run-evidence spec deletes (launch change #7): a suspension, a role
// revocation, or an emergency deny landing mid-run could not reach an already
// running agent, and a JIT grant landing mid-run silently WIDENED it.
//
// The replacement is asymmetric on purpose:
//
//   PINNED   an immutable `AgentRunAuthorizationBinding` — the human ∩ agent
//            ceiling resolved at admission, preserving assignment ids, role
//            ids, conditions, resource scopes, and every per-binding expiry.
//            It is the run's NON-EXPANDING authority: a grant issued after
//            admission is not in it and can never enter it.
//   LIVE     a cache keyed by the deny-generation vector, capability,
//            resource-scope digest, client IP, and the exact next validity
//            boundary. A generation bump (principal suspension, PRA change,
//            role/role-grant change, emergency deny — all five carry an
//            in-transaction trigger) changes the key, so the next operation
//            misses the cache and re-evaluates. Crossing the boundary instant
//            invalidates the entry on the clock.
//
// Ceiling ∩ live authority is therefore monotonically NARROWING for the life
// of the run, which is the property the spec's acceptance criterion 19 states:
// "Later grants cannot expand an active run, while agent suspension, explicit
// revocation, or an emergency-deny generation invalidates cached allows before
// the next operation."
//
// ── V1 delegated runs keep the resolution cache ─────────────────────────────
//
// "Replaced" is scoped to GOVERNED V2 RUNS. The legacy V1 delegated path
// (Agent RBAC Phase 2b/4a/4b) has no admission snapshot to pin and no attempt
// to fence, so it still resolves through `AgentRunIAMResolution` /
// `resolveAgentRunCapability` below — which is also the only carrier of the
// run-constant `resourceScope` dimensions (MCP rules, skills, subagent refs)
// that the pinned/live pair does not model. Both live here on purpose: they
// share `resolveAgentEffectivePermissions`, so there is exactly ONE policy
// engine and the two models can never disagree about agent ∩ human deny-wins.
// V2 execution never populates `resolution`, and the V1 memo is never the
// gate for a V2 run.
//
// This module stays PURE — no I/O, no digest primitives, no DB. It owns the
// shapes and the deterministic ordering; `@oxagen/iam` owns reading rows,
// digesting the canonical form, and persisting decisions. That split is forced
// as well as tidy: @oxagen/oxagen cannot import @oxagen/agent-runner (whose
// canonicalJson/digestOfCanonicalJson helpers live there) without the cycle
// oxagen → agent-runner → database → oxagen.

import type { CapabilityEffect, ResolvedPrincipal } from "../types";
// Type-only — erased at compile time, so no runtime cycle with agent-schema.
import type { GraphAccess } from "../agent-schema";
import {
  intersectEffectiveScope,
  resolveAgentEffectivePermissions,
  type EffectivePermissions,
  type EffectiveResourceScope,
  type Grant,
  type Policy,
  type ResolveScope,
  type Role,
  type RoleGrant,
} from "./resolve";

// ═════════════════════════════════════════════════════════════════════════════
// The pinned grant ceiling
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The org/workspace deny-generation pair observed at one instant. Both counters
 * are monotonic and bumped IN THE SAME TRANSACTION as the mutation that could
 * narrow authority (see the five triggers in migration
 * 20260813110000_agent_run_authorization_foundation.sql), so a strictly greater
 * value on a later read means "some authority changed; nothing cached is
 * trustworthy".
 *
 * A scope with no counter row has never been bumped, so its generation is 0 —
 * the application role holds SELECT only on `iam.authorization_deny_generations`
 * and cannot insert a row to fake one.
 */
export interface DenyGenerationVector {
  readonly org: number;
  /** 0 for an org-scoped operation that precedes a workspace selection. */
  readonly workspace: number;
}

/** One role definition pinned into the ceiling. */
export interface PinnedRole {
  readonly roleId: string;
  readonly name: string;
  readonly scopeKind: "org" | "workspace";
  readonly isSystemDefault: boolean;
}

/**
 * One role assignment pinned into the ceiling, WITH its own expiry.
 *
 * The assignment id is preserved deliberately: the live check matches pinned
 * bindings to live rows by id, so a revoked-and-reissued assignment is a
 * DIFFERENT binding and cannot revive the pinned one. Flattening the ceiling to
 * a capability allowlist would lose exactly this, which is why the spec forbids
 * it ("never flatten them into an allowlist that can be refreshed from later
 * grants").
 */
export interface PinnedRoleAssignment {
  readonly assignmentId: string;
  readonly principalId: string;
  readonly roleId: string;
  /** NULL = an org-wide assignment. */
  readonly workspaceId: string | null;
  /** RFC 3339. */
  readonly assignedAt: string;
  /** RFC 3339, or null when the assignment does not expire on a clock. */
  readonly expiresAt: string | null;
}

/** One role grant pinned into the ceiling, with its conditions verbatim. */
export interface PinnedRoleGrant {
  readonly grantId: string;
  readonly roleId: string;
  readonly capabilityId: string;
  readonly effect: CapabilityEffect;
  /**
   * `role_grants.conditions_jsonb` exactly as stored — the agent-RBAC
   * resourceScope ceiling plus any time/IP conditions. Preserved verbatim so
   * the live re-check evaluates the pinned side against its ORIGINAL
   * conditions, not against whatever the row says now.
   */
  readonly conditions: unknown | null;
}

/**
 * The canonical human ∩ agent grant ceiling. Every field is ordered
 * deterministically by `canonicalGrantCeiling` before digesting, so the same
 * authority always produces the same `grant_ceiling_digest`.
 */
export interface AuthorizationGrantCeiling {
  readonly version: 1;
  /** The authenticated human who delegated this run. */
  readonly initiatingPrincipalId: string;
  /** The deployed agent's own delegated principal. */
  readonly agentPrincipalId: string;
  readonly roles: readonly PinnedRole[];
  /** Assignments of BOTH ceiling principals — the intersection's two sides. */
  readonly assignments: readonly PinnedRoleAssignment[];
  readonly roleGrants: readonly PinnedRoleGrant[];
  /**
   * For a child (subagent) ceiling: the parent snapshot this narrowed from.
   * Null for a root run. A child ceiling is `still-valid parent ∩ current live
   * authority ∩ child narrowing`; it never snapshots current grants afresh.
   */
  readonly parentSnapshotId: string | null;
  /** The narrowing applied on top of the parent ceiling. Null for a root run. */
  readonly narrowing: ChildRunNarrowingPolicy | null;
}

/**
 * The additional ceiling a dispatching parent imposes on a child run. Narrowing
 * only — every field can shrink the parent ceiling and none can widen it.
 */
export interface ChildRunNarrowingPolicy {
  /**
   * When present, the child ceiling keeps ONLY these capabilities. A capability
   * absent from the parent ceiling is not added by listing it here.
   */
  readonly capabilityAllowlist?: readonly string[];
  /**
   * RFC 3339 hard expiry for the child. The effective boundary is the EARLIER
   * of this and the parent's, so a child can never outlive its parent.
   */
  readonly expiresAt?: string | null;
}

/**
 * The immutable authorization binding a run carries for its whole life: the
 * `ras_` snapshot it was admitted under, the ceiling itself, and the generation
 * vector observed when the ceiling was resolved.
 *
 * Every field is readonly. Nothing in a run mutates its ceiling — narrowing
 * happens at evaluation time by intersecting with live authority, never by
 * rewriting the binding.
 */
export interface AgentRunAuthorizationBinding {
  /** Internal UUID — stays internal, used for the decision row's FK. */
  readonly snapshotId: string;
  /** `ras_…` — the only form that crosses a wire or replay boundary. */
  readonly snapshotPublicId: string;
  readonly snapshotDigest: string;
  readonly grantCeilingDigest: string;
  readonly ceiling: AuthorizationGrantCeiling;
  /** The generation vector at admission — the floor the live check compares to. */
  readonly denyGenerationAtAdmission: DenyGenerationVector;
  /** RFC 3339 instant at which some pinned binding first expires, or null. */
  readonly nextValidityBoundaryAt: string | null;
  /** RFC 3339. */
  readonly resolvedAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Canonical ordering (digest input)
// ═════════════════════════════════════════════════════════════════════════════

function byString<T>(pick: (item: T) => string) {
  return (a: T, b: T): number => {
    const left = pick(a);
    const right = pick(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/**
 * Project a ceiling into the plain, deterministically ordered JSON object that
 * gets digested. Snake_case keys and sorted collections: the digest must be
 * reproducible from an exported snapshot by a verifier that never saw our
 * TypeScript.
 *
 * Returns a plain object (not a class, no `undefined` values) because the
 * canonical-JSON writer in `@oxagen/agent-runner` rejects `undefined` outright
 * rather than coercing it to null — a silently-coerced field would change the
 * document a digest claims to cover.
 */
export function canonicalGrantCeiling(
  ceiling: AuthorizationGrantCeiling,
): Record<string, unknown> {
  return {
    version: ceiling.version,
    initiating_principal_id: ceiling.initiatingPrincipalId,
    agent_principal_id: ceiling.agentPrincipalId,
    roles: [...ceiling.roles].sort(byString((r) => r.roleId)).map((r) => ({
      role_id: r.roleId,
      name: r.name,
      scope_kind: r.scopeKind,
      is_system_default: r.isSystemDefault,
    })),
    assignments: [...ceiling.assignments]
      .sort(byString((a) => a.assignmentId))
      .map((a) => ({
        assignment_id: a.assignmentId,
        principal_id: a.principalId,
        role_id: a.roleId,
        workspace_id: a.workspaceId,
        assigned_at: a.assignedAt,
        expires_at: a.expiresAt,
      })),
    role_grants: [...ceiling.roleGrants]
      .sort(byString((g) => g.grantId))
      .map((g) => ({
        grant_id: g.grantId,
        role_id: g.roleId,
        capability_id: g.capabilityId,
        effect: g.effect,
        conditions: g.conditions ?? null,
      })),
    parent_snapshot_id: ceiling.parentSnapshotId,
    narrowing:
      ceiling.narrowing === null
        ? null
        : {
            capability_allowlist:
              ceiling.narrowing.capabilityAllowlist === undefined
                ? null
                : [...ceiling.narrowing.capabilityAllowlist].sort(),
            expires_at: ceiling.narrowing.expiresAt ?? null,
          },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Ceiling → resolver inputs
// ═════════════════════════════════════════════════════════════════════════════

/** The four collections the pure resolver consumes. */
export interface CeilingResolverInputs {
  readonly roles: readonly Role[];
  readonly roleGrants: readonly RoleGrant[];
  readonly grants: readonly Grant[];
  readonly policies: readonly Policy[];
}

/**
 * The CURRENT authz rows a run resolves its live side against: every role in
 * the org, the live role memberships of both ceiling principals, and every
 * role-grant of those roles across ALL capabilities.
 *
 * Structurally identical to `CeilingResolverInputs` and kept as its own name
 * because the two are read at different times for different purposes — the
 * ceiling is pinned once at admission, this is re-read on every operation.
 */
export type AgentAuthzSnapshot = CeilingResolverInputs;

/**
 * Project the PINNED ceiling into resolver inputs as of `now`, dropping every
 * assignment whose own `expiresAt` has passed.
 *
 * This is where "a later or replacement grant can never revive an expired
 * member of the pinned ceiling" is actually enforced: the expired assignment
 * simply is not in the roles' `principalIds`, so the pinned resolution falls
 * through to the capability's defaultEffect for that binding. Because the final
 * outcome is `narrower(pinned, live)`, a live row that reinstates the same role
 * cannot pull the result back up.
 *
 * A `capabilityAllowlist` narrowing drops non-listed grants here rather than at
 * snapshot time, so the ceiling row keeps the full audit of what was narrowed.
 */
export function pinnedCeilingResolverInputs(
  ceiling: AuthorizationGrantCeiling,
  now: Date,
): CeilingResolverInputs {
  const nowMs = now.getTime();
  const liveAssignments = ceiling.assignments.filter((a) => {
    if (a.expiresAt === null) return true;
    const expiry = Date.parse(a.expiresAt);
    // An unparseable expiry is a corrupt pinned binding — drop it (fail closed)
    // rather than treat it as "never expires".
    return Number.isFinite(expiry) && expiry > nowMs;
  });

  const membersByRole = new Map<string, string[]>();
  for (const assignment of liveAssignments) {
    const members = membersByRole.get(assignment.roleId) ?? [];
    if (!members.includes(assignment.principalId)) {
      members.push(assignment.principalId);
    }
    membersByRole.set(assignment.roleId, members);
  }

  const allowlist = ceiling.narrowing?.capabilityAllowlist;
  const allowedCapabilities =
    allowlist === undefined ? null : new Set(allowlist);

  const roles: Role[] = ceiling.roles.map((r) => ({
    id: r.roleId,
    name: r.name,
    scopeKind: r.scopeKind,
    orgId: "",
    isSystemDefault: r.isSystemDefault,
    principalIds: membersByRole.get(r.roleId) ?? [],
  }));

  const roleGrants: RoleGrant[] = ceiling.roleGrants
    .filter(
      (g) =>
        allowedCapabilities === null || allowedCapabilities.has(g.capabilityId),
    )
    .map((g) => ({
      roleId: g.roleId,
      capabilityId: g.capabilityId,
      effect: g.effect,
      conditionsJsonb: g.conditions ?? undefined,
    }));

  // Direct grants and policies tables were dropped in migration 0027 — the
  // ceiling is role-based only (see fetch-agent-authz.ts).
  return { roles, roleGrants, grants: [], policies: [] };
}

/**
 * The earliest future expiry among a ceiling's assignments plus any narrowing
 * expiry — the instant at which cached allows stop being valid on the clock
 * alone, with no generation bump to notice.
 */
export function nextValidityBoundary(
  ceiling: AuthorizationGrantCeiling,
  now: Date,
): string | null {
  const nowMs = now.getTime();
  let earliest: number | null = null;
  const consider = (iso: string | null | undefined): void => {
    if (iso === null || iso === undefined) return;
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || at <= nowMs) return;
    if (earliest === null || at < earliest) earliest = at;
  };
  for (const assignment of ceiling.assignments) consider(assignment.expiresAt);
  consider(ceiling.narrowing?.expiresAt);
  return earliest === null ? null : new Date(earliest).toISOString();
}

// ═════════════════════════════════════════════════════════════════════════════
// The live decision cache
// ═════════════════════════════════════════════════════════════════════════════

/** The outcome vocabulary shared by the resolver and the persisted decision. */
export type AgentRunAuthorizationOutcome =
  | "allow"
  | "deny"
  | "pending_approval";

/**
 * The platform-created reference to one persisted `iam.authorization_decisions`
 * row. A caller can never supply one: the kernel strips any inbound value and
 * only the IAM runtime, having actually inserted the row, produces it.
 */
export interface AuthorizationDecisionRef {
  /** `azd_…` — the public form. The internal UUID never leaves the DB layer. */
  readonly publicId: string;
  readonly outcome: "allow" | "deny" | "approval_pending" | "error";
  readonly decisionDigest: string;
  readonly denyGeneration: DenyGenerationVector;
  /** RFC 3339. */
  readonly decidedAt: string;
}

/** One cached live evaluation. Valid only for its exact cache key AND window. */
export interface AgentRunLiveDecision {
  readonly outcome: AgentRunAuthorizationOutcome;
  readonly reason?: string;
  readonly resourceScope: EffectiveResourceScope;
  readonly decision: AuthorizationDecisionRef | null;
  readonly evaluatedAt: Date;
  /**
   * Wall-clock instant after which this entry is stale even if nothing bumped a
   * generation — the pinned ceiling's next validity boundary. Null when nothing
   * in the ceiling expires on a clock.
   */
  readonly validUntil: Date | null;
}

/**
 * The per-run live cache. Lives ON the run context object, never in module
 * state: runs are concurrent, and a module-global cache would bleed one run's
 * authority into another.
 */
export type AgentRunLiveAuthorizationCache = Map<string, AgentRunLiveDecision>;

export interface AgentRunLiveCacheKeyArgs {
  readonly denyGeneration: DenyGenerationVector;
  readonly capability: string;
  /** Digest of the resource scope this operation targets, or null. */
  readonly resourceScopeDigest: string | null;
  readonly clientIp: string | null;
  /** RFC 3339, or null. */
  readonly nextValidityBoundaryAt: string | null;
}

/**
 * Build the live-cache key. Every component is load-bearing:
 *
 *   generation vector       a suspension/revocation/emergency deny bumps it, so
 *                           the next operation misses and re-evaluates
 *   capability              obvious
 *   resource-scope digest   the same capability against a different resource is
 *                           a different decision
 *   client IP               `ip_ranges`/`ip_allow` conditions resolve per-IP
 *   next validity boundary  a ceiling whose boundary moved is a different
 *                           ceiling; paired with `validUntil` on the entry it
 *                           also expires the cache on the clock
 */
export function agentRunLiveCacheKey(args: AgentRunLiveCacheKeyArgs): string {
  return [
    `g${args.denyGeneration.org}.${args.denyGeneration.workspace}`,
    args.capability,
    args.resourceScopeDigest ?? "-",
    args.clientIp ?? "-",
    args.nextValidityBoundaryAt ?? "-",
  ].join("|");
}

/**
 * Read a cached live decision, treating an entry whose validity window has
 * closed as absent. Deliberately not a bare `Map.get`: the boundary component
 * of the key only detects a CHANGED boundary, not a CROSSED one, and a pinned
 * assignment expiring mid-run bumps no generation.
 */
export function readAgentRunLiveDecision(
  cache: AgentRunLiveAuthorizationCache,
  key: string,
  now: Date,
): AgentRunLiveDecision | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (
    entry.validUntil !== null &&
    now.getTime() >= entry.validUntil.getTime()
  ) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

/** Deny-wins narrowing of two outcomes. Never widens: deny < pending < allow. */
export function narrowerOutcome(
  a: AgentRunAuthorizationOutcome,
  b: AgentRunAuthorizationOutcome,
): AgentRunAuthorizationOutcome {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "pending_approval" || b === "pending_approval") {
    return "pending_approval";
  }
  return "allow";
}

// ═════════════════════════════════════════════════════════════════════════════
// The agent-run IAM context
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The agent-run IAM context a CapabilityContext carries when a capability is
 * invoked from a governed run.
 *
 * `authorization` is the immutable admission binding (present for every V2
 * governed run). `liveCache` is the only mutable slot — and it is a CACHE, not
 * a decision: every entry is keyed by the generation vector it was computed
 * under, so it can only ever serve a decision that is still current.
 */
export interface AgentRunIAMContext {
  /** Discriminator — an agent run's context is always kind "agent". */
  readonly principalKind: "agent";
  /** The deployed agent's own delegated IAM principal. */
  readonly agentPrincipal: ResolvedPrincipal;
  /**
   * The AUTHENTICATED INITIATING human principal — the human who actually
   * authorized this execution.
   *
   * Deliberately NOT derived from `principals.parent_user_id`: that column is
   * the agent's CREATOR, which is not necessarily who ran it. Binding the
   * creator would let anyone who can trigger an agent borrow the creator's
   * ceiling. Null only when the run carries no resolvable delegator, in which
   * case the human side resolves as the unprivileged sentinel below — a
   * missing delegator never widens access.
   */
  readonly humanPrincipal: ResolvedPrincipal | null;
  /** Agent public id (agt_…) — recorded on every audit row (spec §5). */
  readonly agentId: string;
  /** The run this invocation belongs to — audit correlation id. */
  readonly runId: string;
  /** Parent run for subagent dispatches; null/absent for top-level runs. */
  readonly parentRunId?: string | null;
  /**
   * The attempt this invocation belongs to (`arat_` public id's internal
   * UUID). Present once the worker has claimed and created an attempt; absent
   * for admission-time checks that precede the first claim. A decision row
   * binds run+attempt+snapshot together or none of the three.
   */
  readonly attemptId?: string | null;
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
   * Per-run RESOURCE-SCOPE resolution cache — the V1 delegated path only (see
   * the module header's "V1 delegated runs keep the resolution cache" note).
   * Populated by the turn driver before the turn starts; read by tool
   * materialization, the MCP rule gate, and the resource-dimension gates.
   * Cached HERE — on the run context object — deliberately: runs are
   * concurrent, so module-global state is forbidden.
   *
   * A V2 governed run carries `authorization` + `liveCache` instead and never
   * populates this slot; nothing reads it as the allow/deny gate for a V2 run.
   */
  resolution?: AgentRunIAMResolution;
  /**
   * The PINNED admission binding. Absent only for legacy V1 runs that were
   * admitted before snapshots existed — those resolve live-only, which is
   * strictly narrower than a ceiling they never had.
   */
  readonly authorization?: AgentRunAuthorizationBinding;
  /**
   * Per-run live evaluation cache, keyed by generation vector + capability +
   * resource-scope digest + client IP + validity boundary. Written by the
   * kernel IAM check; read by every later check and by tool materialization so
   * the two layers can never diverge into two policies.
   */
  liveCache?: AgentRunLiveAuthorizationCache;
}

/**
 * Sentinel principal used for the human side of the intersection when the run
 * carries no resolvable initiating human. It belongs to no roles and holds no
 * grants, so its resolution falls through to each capability's contract
 * defaultEffect (rule 8) — the most restrictive ceiling we can compute without
 * a real delegator.
 */
export const SENTINEL_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";

/** The human side of the ceiling, substituting the sentinel when unresolved. */
export function ceilingHumanPrincipal(
  runCtx: AgentRunIAMContext,
): ResolvedPrincipal {
  return (
    runCtx.humanPrincipal ?? {
      id: SENTINEL_PRINCIPAL_ID,
      kind: "service",
      orgId: runCtx.agentPrincipal.orgId,
      workspaceId: runCtx.agentPrincipal.workspaceId,
    }
  );
}

/** Fresh, empty live cache for a run context. */
export function createAgentRunLiveCache(): AgentRunLiveAuthorizationCache {
  return new Map<string, AgentRunLiveDecision>();
}

// ═════════════════════════════════════════════════════════════════════════════
// V1 delegated runs — the retained resolution cache
// ═════════════════════════════════════════════════════════════════════════════
//
// See the module header: this is the pre-run-evidence resolution object, kept
// for the LEGACY V1 delegated path (Agent RBAC Phase 2b/4a/4b) and for the
// run-constant `resourceScope` dimensions — MCP rules, skills, subagent refs —
// that the pinned/live model does not carry. It is a memoizing wrapper over
// `resolveAgentEffectivePermissions`, the same pure resolver the pinned and
// live sides use, so the two models share one policy engine.

/**
 * The once-per-run resolution object. `snapshot` is the raw authz data;
 * `byCapability` memoizes the per-capability delegation-ceiling result so a
 * second read of the same capability in the same run is a Map lookup.
 */
export interface AgentRunIAMResolution {
  readonly snapshot: AgentAuthzSnapshot;
  /** Memoized per-capability effective permissions (agent ∩ human, deny-wins). */
  readonly byCapability: Map<string, EffectivePermissions>;
  /** When the snapshot was fetched — a V1 run's resolution is never refreshed. */
  readonly resolvedAt: Date;
}

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
 * Resolve one capability for a V1 delegated run against the run's cached
 * snapshot, memoized per capability on `resolution.byCapability`.
 *
 * Memoization is keyed by capability name alone — sound because everything
 * else is run-constant: the scope (a run is pinned to one org+workspace), the
 * defaultEffect (a property of the capability's contract), and the snapshot
 * itself (fetched once per run, never refreshed). `now`/`clientIp` feed
 * grant-condition evaluation on the FIRST resolution of each capability.
 *
 * NOTE the asymmetry with the V2 path deliberately: a V2 governed run's
 * allow/deny gate is `evaluatePinnedAndLiveAuthorization` below, whose live
 * side is re-keyed by the deny-generation vector on every operation. This
 * never-refreshed memo is the V1 contract (spec §3.5) and stays scoped to it.
 */
export function resolveAgentRunCapability(
  runCtx: AgentRunIAMContext,
  resolution: AgentRunIAMResolution,
  args: ResolveAgentRunCapabilityArgs,
): EffectivePermissions {
  const cached = resolution.byCapability.get(args.capability);
  if (cached !== undefined) return cached;

  const permissions = resolveAgentEffectivePermissions({
    agentPrincipal: runCtx.agentPrincipal,
    humanPrincipal: ceilingHumanPrincipal(runCtx),
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

// ═════════════════════════════════════════════════════════════════════════════
// Pinned ∩ live evaluation (pure)
// ═════════════════════════════════════════════════════════════════════════════

export interface EvaluatePinnedAndLiveArgs {
  readonly capability: string;
  readonly scope: ResolveScope;
  readonly defaultEffect: CapabilityEffect;
  readonly agentPrincipal: ResolvedPrincipal;
  readonly humanPrincipal: ResolvedPrincipal;
  /**
   * Resolver inputs derived from the PINNED ceiling as of `now`. Absent for a
   * legacy run with no snapshot, which then resolves live-only.
   */
  readonly pinned: CeilingResolverInputs | null;
  /** Resolver inputs derived from the CURRENT rows. Never optional. */
  readonly live: CeilingResolverInputs;
  readonly now: Date;
  readonly clientIp: string | null;
  /** Parent-run scope ceiling for a dispatched subagent. Narrowing only. */
  readonly parentEffectiveScope?: EffectiveResourceScope;
}

export interface PinnedAndLiveEvaluation {
  readonly outcome: AgentRunAuthorizationOutcome;
  readonly resourceScope: EffectiveResourceScope;
  /** Which side decided — useful in the decision row's reason and in traces. */
  readonly narrowedBy: "pinned" | "live" | "both";
  readonly pinnedPermissions: EffectivePermissions | null;
  readonly livePermissions: EffectivePermissions;
}

/**
 * Resolve the pinned ceiling and the live authority INDEPENDENTLY, then
 * intersect them.
 *
 * Two independent resolutions rather than one merged input set, because they
 * answer different questions: the pinned side asks "was this ever authorized,
 * under the conditions and expiries that applied at admission?" and the live
 * side asks "is it authorized right now?". Merging the row sets first would let
 * a live row satisfy a pinned binding's condition (or vice versa) and silently
 * widen the ceiling.
 *
 * Deny-wins in both directions, so the result is never broader than either
 * side. The existing agent ∩ human delegation ceiling inside
 * `resolveAgentEffectivePermissions` is untouched — this composes with it, it
 * does not replace or weaken it.
 */
export function evaluatePinnedAndLiveAuthorization(
  args: EvaluatePinnedAndLiveArgs,
): PinnedAndLiveEvaluation {
  const common = {
    agentPrincipal: args.agentPrincipal,
    humanPrincipal: args.humanPrincipal,
    capability: args.capability,
    scope: args.scope,
    defaultEffect: args.defaultEffect,
    now: args.now,
    clientIp: args.clientIp,
    // Subagent/A2A narrowing (spec §2.7): the parent run's effective scope is
    // an additional ceiling — intersected dimension-wise by the resolver, so
    // this child resolution can only narrow, never widen, the parent's scope.
    parentEffectiveScope: args.parentEffectiveScope,
  };

  const livePermissions = resolveAgentEffectivePermissions({
    ...common,
    grants: args.live.grants,
    roles: args.live.roles,
    roleGrants: args.live.roleGrants,
    policies: args.live.policies,
  });

  if (args.pinned === null) {
    return {
      outcome: livePermissions.outcome,
      resourceScope: livePermissions.resourceScope,
      narrowedBy: "live",
      pinnedPermissions: null,
      livePermissions,
    };
  }

  const pinnedPermissions = resolveAgentEffectivePermissions({
    ...common,
    grants: args.pinned.grants,
    roles: args.pinned.roles,
    roleGrants: args.pinned.roleGrants,
    policies: args.pinned.policies,
  });

  const outcome = narrowerOutcome(
    pinnedPermissions.outcome,
    livePermissions.outcome,
  );
  const narrowedBy =
    pinnedPermissions.outcome === livePermissions.outcome
      ? "both"
      : outcome === pinnedPermissions.outcome
        ? "pinned"
        : "live";

  return {
    outcome,
    // Dimension-wise intersection via the resolver's own intersector, so there
    // is exactly one implementation of "narrow a scope".
    resourceScope: intersectEffectiveScope(
      pinnedPermissions.resourceScope,
      livePermissions.resourceScope,
    ),
    narrowedBy,
    pinnedPermissions,
    livePermissions,
  };
}
