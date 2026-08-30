// live-agent-run-authorization.ts — the LIVE half of the pinned-ceiling model
// (docs/specs/run-evidence-ingress/spec.md §"Security and retention rules";
// 02-run-attempt-foundation-plan.md Task 5).
//
// The pinned ceiling (authorization-snapshot.ts) answers "was this ever
// authorized?". This module answers "is it authorized RIGHT NOW?", and
// persists the answer.
//
// On EVERY context / model / tool / kernel boundary of a governed run it:
//
//   1. reads live principal + agent status, active emergency denies, and both
//      deny-generation counters — all under one MVCC snapshot;
//   2. re-evaluates the PINNED side against its ORIGINAL assignment conditions
//      and expiries, not against whatever the rows say now;
//   3. intersects that with freshly resolved LIVE authority;
//   4. persists one immutable `iam.authorization_decisions` row (`azd_…`) for
//      the result — allow, deny, approval-pending, or evaluation error alike;
//   5. returns the platform-created decision reference.
//
// Deny-wins throughout, in both directions. A suspension, a revocation, a
// pinned expiry, or an emergency deny narrows before the next operation; a
// later or replacement grant can never revive an expired member of the pinned
// ceiling, because step 2 drops it and step 3 is an intersection, not a union.
//
// ANY refresh failure denies. That is not defensive coding — an agent run is an
// unattended automation, so "we could not tell" and "not allowed" have to be
// the same answer.

import { schema, type Tx } from "@oxagen/database";
import { withRepeatableReadTenantDb } from "@oxagen/database/tenant";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  agentRunLiveCacheKey,
  ceilingHumanPrincipal,
  createAgentRunLiveCache,
  evaluatePinnedAndLiveAuthorization,
  pinnedCeilingResolverInputs,
  readAgentRunLiveDecision,
  type AgentRunAuthorizationOutcome,
  type AgentRunIAMContext,
  type AgentRunLiveAuthorizationCache,
  type AgentRunLiveDecision,
  type AuthorizationDecisionRef,
  type CeilingResolverInputs,
  type DenyGenerationVector,
  type EffectiveResourceScope,
  type ResolveScope,
  type Role,
  type RoleGrant,
} from "@oxagen/oxagen/iam";
import type { CapabilityEffect } from "@oxagen/oxagen";
import { digestOfCanonicalJson } from "@oxagen/agent-runner/run-spec-v2";
import {
  readLiveAuthority,
  type LiveAuthorityState,
} from "./authorization-snapshot";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Deny reasons
// ---------------------------------------------------------------------------

/**
 * Why a live check narrowed. Stable machine-readable codes: they land in
 * `authorization_decisions.reason_code` and are the queryable answer to "why
 * did this agent stop being able to do X mid-run?".
 */
export type LiveDenyReason =
  | "principal_suspended"
  | "principal_deleted"
  | "principal_not_found"
  | "agent_disabled"
  | "emergency_deny"
  | "pinned_expired"
  | "ceiling_denies"
  | "live_denies"
  | "refresh_failed"
  | "decision_not_persisted";

// ---------------------------------------------------------------------------
// Emergency denies
// ---------------------------------------------------------------------------

export interface ActiveEmergencyDeny {
  readonly publicId: string;
  readonly denyKind: "capability" | "resource_scope";
  readonly capabilityId: string | null;
  readonly resourceScopeDigest: string | null;
  readonly principalId: string | null;
  readonly reason: string;
}

/**
 * Read the active emergency denies for this scope.
 *
 * Only `active = true` rows are scanned (the partial index covers exactly
 * those), and org-wide rows (`workspace_id IS NULL`) apply to every workspace —
 * matching the table's own `workspace_nullable` RLS shape.
 */
export async function readActiveEmergencyDenies(
  tx: Tx,
  args: { orgId: string; workspaceId: string | null },
): Promise<readonly ActiveEmergencyDeny[]> {
  const rows = await tx
    .select({
      publicId: schema.emergencyDenies.publicId,
      denyKind: schema.emergencyDenies.denyKind,
      capabilityId: schema.emergencyDenies.capabilityId,
      resourceScopeDigest: schema.emergencyDenies.resourceScopeDigest,
      principalId: schema.emergencyDenies.principalId,
      reason: schema.emergencyDenies.reason,
    })
    .from(schema.emergencyDenies)
    .where(
      and(
        eq(schema.emergencyDenies.orgId, args.orgId),
        eq(schema.emergencyDenies.active, true),
        args.workspaceId === null
          ? isNull(schema.emergencyDenies.workspaceId)
          : or(
              isNull(schema.emergencyDenies.workspaceId),
              eq(schema.emergencyDenies.workspaceId, args.workspaceId),
            ),
      ),
    );

  return rows.map((r) => ({
    publicId: r.publicId,
    denyKind: r.denyKind === "resource_scope" ? "resource_scope" : "capability",
    capabilityId: r.capabilityId,
    resourceScopeDigest: r.resourceScopeDigest,
    principalId: r.principalId,
    reason: r.reason,
  }));
}

/**
 * Does an active emergency deny cover this operation?
 *
 * A row with `principal_id = NULL` denies for every principal in the scope; a
 * row naming a principal denies only for that one. Capability matching is
 * exact — glob expansion would turn an emergency deny into a policy evaluation,
 * and the point of the typed shape is that the live check stays an index lookup
 * on the hot path.
 *
 * NOTE: a `resource_scope` row can only match when the caller supplies
 * `resourceScopeDigest`. The kernel path (check-iam.ts) does not compute one
 * today, so only `capability` rows fire on a live invocation — a
 * `resource_scope` emergency deny is currently inert outside this function's
 * own tests.
 */
export function matchEmergencyDeny(
  denies: readonly ActiveEmergencyDeny[],
  args: {
    capability: string;
    resourceScopeDigest: string | null;
    principalIds: readonly string[];
  },
): ActiveEmergencyDeny | null {
  for (const deny of denies) {
    if (
      deny.principalId !== null &&
      !args.principalIds.includes(deny.principalId)
    ) {
      continue;
    }
    if (deny.denyKind === "capability") {
      if (deny.capabilityId === args.capability) return deny;
      continue;
    }
    if (
      args.resourceScopeDigest !== null &&
      deny.resourceScopeDigest === args.resourceScopeDigest
    ) {
      return deny;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The live read
// ---------------------------------------------------------------------------

/** Everything the live check needs, read on ONE MVCC snapshot. */
export interface LiveAgentRunAuthority {
  readonly authority: LiveAuthorityState;
  readonly emergencyDenies: readonly ActiveEmergencyDeny[];
  readonly agentDisabled: boolean;
}

export interface ReadLiveAgentRunAuthorityArgs {
  orgId: string;
  workspaceId: string;
  agentPrincipalId: string;
  humanPrincipalId: string | null;
  /** Agent public id (agt_…) or UUID, to confirm the agent itself still exists. */
  agentId?: string | null;
}

export type ReadLiveAgentRunAuthorityFn = (
  args: ReadLiveAgentRunAuthorityArgs,
) => Promise<LiveAgentRunAuthority>;

/**
 * Read live authority + emergency denies + agent enablement in ONE
 * repeatable-read transaction.
 *
 * The single-snapshot property matters as much here as at admission: a check
 * that read the generation BEFORE a revocation committed and the grants AFTER
 * it would cache an allow under a generation that already knew better — and
 * since the generation is part of the cache key, the stale allow would keep
 * being served until something else moved.
 */
export const readLiveAgentRunAuthority: ReadLiveAgentRunAuthorityFn = (args) =>
  withRepeatableReadTenantDb(async (tx) => {
    const principalIds = [
      args.agentPrincipalId,
      ...(args.humanPrincipalId !== null ? [args.humanPrincipalId] : []),
    ];

    const authority = await readLiveAuthority(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      principalIds,
    });
    const emergencyDenies = await readActiveEmergencyDenies(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
    });
    const agentDisabled = await readAgentDisabled(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      agentId: args.agentId ?? null,
    });

    return { authority, emergencyDenies, agentDisabled };
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent row can be soft-deleted independently of its principal, so this is
 * a separate check rather than an inference from principal status. An agent
 * that cannot be found is not an agent that may execute.
 */
async function readAgentDisabled(
  tx: Tx,
  args: { orgId: string; workspaceId: string; agentId: string | null },
): Promise<boolean> {
  if (args.agentId === null) return false;
  const [row] = await tx
    .select({ deletedAt: schema.agents.deletedAt })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, args.orgId),
        eq(schema.agents.workspaceId, args.workspaceId),
        UUID_RE.test(args.agentId)
          ? eq(schema.agents.id, args.agentId)
          : eq(schema.agents.publicId, args.agentId),
      ),
    )
    .limit(1);
  return row === undefined || row.deletedAt !== null;
}

// ---------------------------------------------------------------------------
// Live authority → resolver inputs
// ---------------------------------------------------------------------------

/**
 * Project CURRENT rows into resolver inputs, dropping assignments that have
 * already expired. Mirrors `pinnedCeilingResolverInputs` so both sides of the
 * intersection are computed the same way, and any difference in the result is a
 * real difference in authority rather than an artifact of two projections.
 */
export function liveResolverInputs(
  authority: LiveAuthorityState,
  now: Date,
): CeilingResolverInputs {
  const nowMs = now.getTime();
  const membersByRole = new Map<string, string[]>();
  for (const assignment of authority.assignments) {
    if (
      assignment.expiresAt !== null &&
      assignment.expiresAt.getTime() <= nowMs
    ) {
      continue;
    }
    const members = membersByRole.get(assignment.roleId) ?? [];
    if (!members.includes(assignment.principalId)) {
      members.push(assignment.principalId);
    }
    membersByRole.set(assignment.roleId, members);
  }

  const roles: Role[] = authority.roles.map((r) => ({
    id: r.roleId,
    name: r.name,
    scopeKind: r.scopeKind,
    orgId: "",
    isSystemDefault: r.isSystemDefault,
    principalIds: membersByRole.get(r.roleId) ?? [],
  }));

  const roleGrants: RoleGrant[] = authority.roleGrants.map((g) => ({
    roleId: g.roleId,
    capabilityId: g.capabilityId,
    effect: g.effect,
    conditionsJsonb: g.conditions ?? undefined,
  }));

  return { roles, roleGrants, grants: [], policies: [] };
}

// ---------------------------------------------------------------------------
// Decision persistence
// ---------------------------------------------------------------------------

/** The four outcomes an `authorization_decisions` row may record. */
export type PersistedDecisionOutcome =
  | "allow"
  | "deny"
  | "approval_pending"
  | "error";

export interface PersistAuthorizationDecisionArgs {
  orgId: string;
  workspaceId: string | null;
  capability: string;
  requestId: string;
  actorPrincipalId: string;
  onBehalfOfPrincipalId: string | null;
  resourceScopeDigest: string | null;
  /**
   * Run bindings. All three or none — a partial binding cannot be audited back
   * to an attempt, and the table's own CHECK enforces the same rule.
   */
  runBinding: {
    runId: string;
    attemptId: string;
    authorizationSnapshotId: string;
  } | null;
  denyGeneration: DenyGenerationVector;
  outcome: PersistedDecisionOutcome;
  reasonCode: string | null;
  approvalRequestId: string | null;
  /** Canonical digest over this invocation's validated input. */
  inputDigest: string;
  /** Digest over the evaluation trace, when one was produced. */
  traceDigest: string | null;
  decidedAt?: Date;
}

export type PersistAuthorizationDecisionFn = (
  args: PersistAuthorizationDecisionArgs,
) => Promise<AuthorizationDecisionRef>;

/**
 * Reasons that mean "the check could not be EVALUATED", as opposed to
 * "evaluated, and the answer is no". Both deny the operation — that is the
 * fail-closed rule — but the decision row must say which, or an operator
 * reading the ledger cannot tell a policy denial from an outage.
 */
const EVALUATION_FAILURE_REASONS: ReadonlySet<LiveDenyReason> = new Set([
  "refresh_failed",
]);

/**
 * Map an agent-run outcome (+ its reason) onto the persisted vocabulary.
 *
 * `approval_pending` is the table's spelling of `pending_approval`. `error` is
 * reserved for an evaluation failure, so the four-valued column really carries
 * four distinct meanings rather than three plus an unused slot.
 */
export function persistedOutcomeOf(
  outcome: AgentRunAuthorizationOutcome,
  reason: LiveDenyReason | null = null,
): PersistedDecisionOutcome {
  if (reason !== null && EVALUATION_FAILURE_REASONS.has(reason)) return "error";
  return outcome === "pending_approval" ? "approval_pending" : outcome;
}

/**
 * Insert the immutable decision row and return its platform-created reference.
 *
 * `decision_digest` covers every field the row asserts, so an exported decision
 * is verifiable without the database. It deliberately includes the generation
 * vector: a decision read back at a higher generation is known-stale by
 * inspection alone, with no join.
 *
 * Throws on failure. Callers MUST treat that as a deny — see
 * `evaluateAgentRunAuthorization`, which converts it into
 * `decision_not_persisted` rather than letting the operation proceed.
 */
export const persistAuthorizationDecision: PersistAuthorizationDecisionFn = (
  args,
) => {
  const decidedAt = args.decidedAt ?? new Date();
  const scopeKind = args.workspaceId === null ? "org" : "workspace";

  const decisionDigest = digestOfCanonicalJson({
    version: 1,
    org_id: args.orgId,
    workspace_id: args.workspaceId,
    capability_id: args.capability,
    request_id: args.requestId,
    actor_principal_id: args.actorPrincipalId,
    on_behalf_of_principal_id: args.onBehalfOfPrincipalId,
    scope_kind: scopeKind,
    resource_scope_digest: args.resourceScopeDigest,
    run_id: args.runBinding?.runId ?? null,
    attempt_id: args.runBinding?.attemptId ?? null,
    authorization_snapshot_id: args.runBinding?.authorizationSnapshotId ?? null,
    deny_generation: {
      org: args.denyGeneration.org,
      workspace: args.denyGeneration.workspace,
    },
    outcome: args.outcome,
    reason_code: args.reasonCode,
    approval_request_id: args.approvalRequestId,
    input_digest: args.inputDigest,
    trace_digest: args.traceDigest,
    decided_at: decidedAt.toISOString(),
  });

  return withRepeatableReadTenantDb(async (tx) => {
    const [row] = await tx
      .insert(schema.authorizationDecisions)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        capabilityId: args.capability,
        requestId: args.requestId,
        actorPrincipalId: args.actorPrincipalId,
        onBehalfOfPrincipalId: args.onBehalfOfPrincipalId,
        scopeKind,
        resourceScopeDigest: args.resourceScopeDigest,
        runId: args.runBinding?.runId ?? null,
        attemptId: args.runBinding?.attemptId ?? null,
        authorizationSnapshotId:
          args.runBinding?.authorizationSnapshotId ?? null,
        orgDenyGeneration: args.denyGeneration.org,
        // The table's CHECK ties "workspace scope" to "has a workspace
        // generation": an org-scoped decision must record NULL, never 0.
        workspaceDenyGeneration:
          args.workspaceId === null ? null : args.denyGeneration.workspace,
        outcome: args.outcome,
        reasonCode: args.reasonCode,
        approvalRequestId: args.approvalRequestId,
        inputDigest: args.inputDigest,
        traceDigest: args.traceDigest,
        decisionDigest,
        decidedAt,
      })
      .returning({ publicId: schema.authorizationDecisions.publicId });

    if (row === undefined) {
      throw new Error(
        "authorization_decisions INSERT returned no row — the decision is unrecorded.",
      );
    }

    return {
      publicId: row.publicId,
      outcome: args.outcome,
      decisionDigest,
      denyGeneration: args.denyGeneration,
      decidedAt: decidedAt.toISOString(),
    };
  });
};

// ---------------------------------------------------------------------------
// The evaluation entry point
// ---------------------------------------------------------------------------

export interface EvaluateAgentRunAuthorizationArgs {
  agentRun: AgentRunIAMContext;
  capability: string;
  scope: ResolveScope;
  defaultEffect: CapabilityEffect;
  requestId: string;
  /** Canonical digest over this invocation's validated input. */
  inputDigest: string;
  /** Digest of the resource this operation targets, when one applies. */
  resourceScopeDigest?: string | null;
  clientIp?: string | null;
  now?: Date;
  /** Seam for tests; defaults to the real repeatable-read read. */
  readAuthority?: ReadLiveAgentRunAuthorityFn;
  /** Seam for tests; defaults to the real insert. */
  persistDecision?: PersistAuthorizationDecisionFn;
}

export interface AgentRunAuthorizationResult {
  readonly outcome: AgentRunAuthorizationOutcome;
  readonly reason: LiveDenyReason | null;
  readonly resourceScope: EffectiveResourceScope;
  /**
   * The platform-created decision reference. Null ONLY when the row could not
   * be written — in which case `outcome` is already `deny` with reason
   * `decision_not_persisted`.
   */
  readonly decision: AuthorizationDecisionRef | null;
  /** True when this result was served from the run's live cache. */
  readonly cached: boolean;
  readonly denyGeneration: DenyGenerationVector;
}

/** The narrowing verdict before a decision row exists for it. */
interface LiveVerdict {
  readonly outcome: AgentRunAuthorizationOutcome;
  readonly reason: LiveDenyReason | null;
  readonly resourceScope: EffectiveResourceScope;
  readonly denyGeneration: DenyGenerationVector;
}

/**
 * The governed-run authorization check. Called at every context / model / tool
 * / kernel boundary of a run.
 *
 * Cache semantics: a hit requires the SAME generation vector, capability,
 * resource-scope digest, client IP, and validity boundary AND a `now` still
 * inside the entry's validity window. Because the generation is part of the
 * key, any of the five mutation surfaces that bump it (principal status, role
 * assignment, role, role grant, emergency deny) forces a fresh evaluation on
 * the very next operation. Because `validUntil` is also checked, a pinned
 * assignment expiring mid-run — which bumps nothing — forces one too.
 *
 * A cache hit does not re-persist a decision: the cached entry carries the
 * reference of the decision that authorized exactly this (capability, scope,
 * generation, window) tuple, and duplicating rows for an unchanged decision
 * would bury the real transitions in noise.
 */
export async function evaluateAgentRunAuthorization(
  args: EvaluateAgentRunAuthorizationArgs,
): Promise<AgentRunAuthorizationResult> {
  const now = args.now ?? new Date();
  const { agentRun } = args;
  const readAuthority = args.readAuthority ?? readLiveAgentRunAuthority;
  const persistDecision = args.persistDecision ?? persistAuthorizationDecision;
  const resourceScopeDigest = args.resourceScopeDigest ?? null;
  const clientIp = args.clientIp ?? null;
  const binding = agentRun.authorization ?? null;
  const boundary = binding?.nextValidityBoundaryAt ?? null;
  const workspaceId =
    args.scope.workspaceId ?? agentRun.agentPrincipal.workspaceId ?? null;

  const cache: AgentRunLiveAuthorizationCache = (agentRun.liveCache ??=
    createAgentRunLiveCache());

  const record = (verdict: LiveVerdict): Promise<AgentRunAuthorizationResult> =>
    recordDecision({
      verdict,
      agentRun,
      binding,
      boundary,
      cache,
      capability: args.capability,
      clientIp,
      inputDigest: args.inputDigest,
      now,
      persistDecision,
      requestId: args.requestId,
      resourceScopeDigest,
      workspaceId,
    });

  // ── 1. Live read. ANY failure denies. ────────────────────────────────────
  let live: LiveAgentRunAuthority;
  try {
    live = await readAuthority({
      orgId: agentRun.agentPrincipal.orgId,
      workspaceId: workspaceId ?? "",
      agentPrincipalId: agentRun.agentPrincipal.id,
      humanPrincipalId: agentRun.humanPrincipal?.id ?? null,
      agentId: agentRun.agentId,
    });
  } catch (err) {
    logger.error(
      { err, capability: args.capability, runId: agentRun.runId },
      "[iam] live authorization refresh FAILED — denying (an unrefreshable " +
        "ceiling is not a valid one)",
    );
    return record({
      outcome: "deny",
      reason: "refresh_failed",
      resourceScope: {},
      // Nothing was read, so nothing is known about the generation. 0/0 is the
      // lowest value any real scope can hold, which makes this decision
      // unambiguously stale on read-back rather than accidentally current.
      denyGeneration: { org: 0, workspace: 0 },
    });
  }

  const denyGeneration = live.authority.denyGeneration;

  // ── 2. Cache lookup, keyed by the generation we just observed. ───────────
  const cacheKey = agentRunLiveCacheKey({
    denyGeneration,
    capability: args.capability,
    resourceScopeDigest,
    clientIp,
    nextValidityBoundaryAt: boundary,
  });
  const cached = readAgentRunLiveDecision(cache, cacheKey, now);
  if (cached !== undefined) {
    return {
      outcome: cached.outcome,
      reason: (cached.reason ?? null) as LiveDenyReason | null,
      resourceScope: cached.resourceScope,
      decision: cached.decision,
      cached: true,
      denyGeneration,
    };
  }

  // ── 3. Hard narrowings that short-circuit the resolver. ──────────────────
  const principalIds = [
    agentRun.agentPrincipal.id,
    ...(agentRun.humanPrincipal !== null ? [agentRun.humanPrincipal.id] : []),
  ];

  const statusDeny = principalStatusDenial(live.authority, principalIds);
  if (statusDeny !== null) {
    return record({
      outcome: "deny",
      reason: statusDeny,
      resourceScope: {},
      denyGeneration,
    });
  }

  if (live.agentDisabled) {
    return record({
      outcome: "deny",
      reason: "agent_disabled",
      resourceScope: {},
      denyGeneration,
    });
  }

  const emergency = matchEmergencyDeny(live.emergencyDenies, {
    capability: args.capability,
    resourceScopeDigest,
    principalIds,
  });
  if (emergency !== null) {
    logger.warn(
      {
        capability: args.capability,
        runId: agentRun.runId,
        emergencyDenyId: emergency.publicId,
      },
      "[iam] emergency deny narrowed a governed run before its next operation",
    );
    return record({
      outcome: "deny",
      reason: "emergency_deny",
      resourceScope: {},
      denyGeneration,
    });
  }

  // ── 4. Pinned ∩ live. ────────────────────────────────────────────────────
  const pinned =
    binding === null ? null : pinnedCeilingResolverInputs(binding.ceiling, now);

  // "The ceiling row still exists but nothing in it is live any more" is a
  // distinct, reportable state — worth its own reason code so an operator can
  // tell an expiry apart from a policy deny.
  const pinnedExhausted =
    pinned !== null &&
    binding !== null &&
    binding.ceiling.assignments.length > 0 &&
    pinned.roles.every((r) => r.principalIds.length === 0);

  const evaluation = evaluatePinnedAndLiveAuthorization({
    capability: args.capability,
    scope: args.scope,
    defaultEffect: args.defaultEffect,
    agentPrincipal: agentRun.agentPrincipal,
    humanPrincipal: ceilingHumanPrincipal(agentRun),
    pinned,
    live: liveResolverInputs(live.authority, now),
    now,
    clientIp,
  });

  // A reason code explains a DENIAL. An allow has none, and neither does a
  // pending_approval — that outcome means the ceiling is intact and an approver
  // has yet to act, which is not a narrowing.
  const reason: LiveDenyReason | null =
    evaluation.outcome !== "deny"
      ? null
      : pinnedExhausted
        ? "pinned_expired"
        : evaluation.narrowedBy === "live"
          ? "live_denies"
          : "ceiling_denies";

  return record({
    outcome: evaluation.outcome,
    reason,
    resourceScope: evaluation.resourceScope,
    denyGeneration,
  });
}

/**
 * Persist the decision, cache it, and shape the result.
 *
 * EVERY exit path of `evaluateAgentRunAuthorization` funnels through here, so
 * no outcome — including the short-circuited denials — can escape without an
 * immutable decision row. A failed insert becomes a deny; it never becomes a
 * silent allow.
 */
async function recordDecision(args: {
  verdict: LiveVerdict;
  agentRun: AgentRunIAMContext;
  binding: AgentRunIAMContext["authorization"] | null;
  boundary: string | null;
  cache: AgentRunLiveAuthorizationCache;
  capability: string;
  clientIp: string | null;
  inputDigest: string;
  now: Date;
  persistDecision: PersistAuthorizationDecisionFn;
  requestId: string;
  resourceScopeDigest: string | null;
  workspaceId: string | null;
}): Promise<AgentRunAuthorizationResult> {
  const { verdict, agentRun, binding } = args;
  const attemptId = agentRun.attemptId ?? null;

  let decision: AuthorizationDecisionRef;
  try {
    decision = await args.persistDecision({
      orgId: agentRun.agentPrincipal.orgId,
      workspaceId: args.workspaceId,
      capability: args.capability,
      requestId: args.requestId,
      actorPrincipalId: agentRun.agentPrincipal.id,
      onBehalfOfPrincipalId: agentRun.humanPrincipal?.id ?? null,
      resourceScopeDigest: args.resourceScopeDigest,
      // All three run bindings or none — the CHECK constraint rejects a partial
      // one, and a decision bound to a run but not an attempt cannot be
      // replayed against the evidence stream.
      runBinding:
        binding !== null && binding !== undefined && attemptId !== null
          ? {
              runId: agentRun.runId,
              attemptId,
              authorizationSnapshotId: binding.snapshotId,
            }
          : null,
      denyGeneration: verdict.denyGeneration,
      outcome: persistedOutcomeOf(verdict.outcome, verdict.reason),
      reasonCode: verdict.reason,
      // Both columns are written NULL on every decision this path records.
      // `approval_request_id`: the JIT access request is minted later, by the
      // kernel's pending_approval path, so its id does not exist yet here.
      // `trace_digest`: this evaluation produces a verdict, not the resolver
      // trace object the column is meant to cover — so `decision_digest` today
      // attests the decision's INPUTS and OUTCOME, not the reasoning behind
      // them. Filling either in means threading a value that no caller
      // currently has; treat both as known gaps, not as spare columns.
      approvalRequestId: null,
      inputDigest: args.inputDigest,
      traceDigest: null,
    });
  } catch (err) {
    logger.error(
      { err, capability: args.capability, runId: agentRun.runId },
      "[iam] SECURITY ALERT: authorization decision could not be persisted — " +
        "denying (an unrecorded decision is not an allowed one)",
    );
    return {
      outcome: "deny",
      reason: "decision_not_persisted",
      resourceScope: {},
      decision: null,
      cached: false,
      denyGeneration: verdict.denyGeneration,
    };
  }

  const entry: AgentRunLiveDecision = {
    outcome: verdict.outcome,
    ...(verdict.reason !== null ? { reason: verdict.reason } : {}),
    resourceScope: verdict.resourceScope,
    decision,
    evaluatedAt: args.now,
    validUntil: args.boundary === null ? null : new Date(args.boundary),
  };
  args.cache.set(
    agentRunLiveCacheKey({
      denyGeneration: verdict.denyGeneration,
      capability: args.capability,
      resourceScopeDigest: args.resourceScopeDigest,
      clientIp: args.clientIp,
      nextValidityBoundaryAt: args.boundary,
    }),
    entry,
  );

  return {
    outcome: verdict.outcome,
    reason: verdict.reason,
    resourceScope: verdict.resourceScope,
    decision,
    cached: false,
    denyGeneration: verdict.denyGeneration,
  };
}

/**
 * Deny when any ceiling principal is not active. Checked BEFORE the resolver
 * runs: a suspended principal's grants are irrelevant, and evaluating them
 * would put a stale allow in the trace of a denial.
 */
function principalStatusDenial(
  authority: LiveAuthorityState,
  principalIds: readonly string[],
): LiveDenyReason | null {
  for (const principalId of principalIds) {
    const row = authority.principals.find((p) => p.principalId === principalId);
    if (row === undefined) return "principal_not_found";
    if (row.status === "suspended") return "principal_suspended";
    if (row.status === "deleted") return "principal_deleted";
  }
  return null;
}
