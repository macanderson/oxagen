// check-iam.ts — combines fetchAuthz + resolve + emitAudit (OXA-1390, Phase 3).
//
// Non-enterprise orgs receive an unconditional allow (zero DB queries, zero
// latency) — FOR NON-AGENT PRINCIPALS ONLY. Enterprise orgs run the full
// resolver: fetchAuthz → resolve → emitAudit.
//
// AGENT RUNS (Agent RBAC Phase 2, docs/specs/agent-rbac/spec.md §3.4/§3.5):
// when the invocation carries an agent-run context (ctx.agentRun /
// principalKind='agent'), resolution runs at ALL org tiers — agent RBAC is a
// core product safety property (an agent is an unattended automation), not an
// enterprise ACL feature. The agent's effective permissions are the delegation
// ceiling — agent principal ∩ invoking human, deny-wins — computed ONCE per
// run from one authz snapshot and cached ON the run context object
// (AgentRunIAMContext.resolution), so kernel checks and tool materialization
// read the same resolution and can never diverge.

import {
  type CapabilityContext,
  type CapabilityEffect,
  type ResolvedPrincipal,
} from "@oxagen/oxagen";
import {
  resolve,
  createAgentRunResolution,
  resolveAgentRunCapability,
  type AgentRunIAMContext,
  type AgentRunIAMResolution,
  type EffectivePermissions,
  type ResolveResult,
  type TraceStep,
} from "@oxagen/oxagen/iam";
import { fetchAuthz } from "./fetch-authz";
import { fetchAgentRunAuthz } from "./fetch-agent-authz";
import { emitAudit } from "./emit-audit";
import { resolveOrgTier, canAccessACL } from "@oxagen/billing";
import { captureError } from "@oxagen/telemetry";
import { logger } from "./logger";

/**
 * OXA-2058: an audit-emission failure (durable write exhausted its retries,
 * or a hash computation failed and emitAudit refused to persist a corrupt
 * row — see emit-audit.ts) must be observable beyond a log line nobody
 * watches. Escalates to ClickHouse `error_events` + optional alert webhook
 * via `captureError`, which is itself fire-and-forget and never throws.
 */
function reportAuditEmissionFailure(
  capability: string,
  ctx: CapabilityContext,
  err: unknown,
): void {
  logger.error(
    { err, capability },
    "[iam:audit] CRITICAL — audit event emission failed",
  );
  captureError({
    error: err,
    source: "api",
    severity: "error",
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability,
    requestId: ctx.requestId,
    context:
      "iam:checkIAM — audit event emission failed after retries (OXA-2058)",
  });
}

export interface CheckIAMArgs {
  capability: string;
  ctx: CapabilityContext;
  defaultEffect: CapabilityEffect;
  /** Serialized raw input for the audit payload hash. */
  rawInputJson: string;
  /**
   * The object this invocation acts on (accountability chain) — derived by
   * the kernel from the contract's declarative `audit` field. Recorded on
   * the audit row as target_kind/target_id.
   */
  target?: { kind: string; id: string } | null;
  /**
   * Which kind of principal is invoking (Agent RBAC spec §3.4). Defaults to
   * the ctx.agentRun discriminator when absent, then "human". The
   * non-enterprise tier fast-path applies ONLY to non-agent principals:
   * "agent" runs the full delegation-ceiling resolution at every org tier.
   */
  principalKind?: "human" | "agent" | "service";
}

export interface CheckIAMResult {
  result: ResolveResult;
  principal: ResolvedPrincipal | null;
}

/**
 * Run the full IAM check for a capability invocation:
 *   fetch authz data → resolve → emit audit (fire-and-forget).
 *
 * Returns the resolver result and the resolved principal so the handler
 * can record authoring metadata.
 *
 * ACL plan-tier gate: for capabilities in the `iam.*` namespace, the org's
 * plan tier is checked first. Non-enterprise orgs do not configure explicit
 * ACL policies, so the resolver is bypassed and the request is ALLOWED —
 * role membership is the correct (and only) access control for those orgs.
 * Enterprise orgs run through the full resolver so explicit ACL grants and
 * policies are enforced.
 */
export async function checkIAM(args: CheckIAMArgs): Promise<CheckIAMResult> {
  const { capability, ctx, defaultEffect, rawInputJson, target } = args;

  // Discriminator (Agent RBAC spec §3.4): explicit arg wins, then the run
  // context's own discriminator, then "human" — the pre-agent-RBAC default,
  // so every existing caller resolves exactly as before.
  const agentRun = ctx.agentRun;
  const principalKind =
    args.principalKind ?? agentRun?.principalKind ?? "human";

  // ── Agent-run resolution — ALL org tiers (spec §3.4) ───────────────────────
  // Runs BEFORE the tier fast-path: agent RBAC is a core safety property, not
  // an enterprise ACL feature, so an agent principal never rides the
  // non-enterprise bypass (the resolveOrgTier lookup is skipped entirely —
  // the tier is irrelevant to an agent check).
  if (principalKind === "agent") {
    if (agentRun === undefined) {
      // An agent invocation without its two-principal run context cannot
      // resolve the delegation ceiling — fail closed, never fall through to
      // the human path (which would resolve the WRONG principal).
      return denyMissingAgentContext(args);
    }
    return checkAgentRunIAM({ agentRun, ...args });
  }

  // ── Non-enterprise fast-path (non-agent principals only) ───────────────────
  // Non-enterprise orgs have no IAM policies to enforce. Skip the resolver
  // entirely and return allow — zero DB queries, zero latency cost.
  // Enterprise orgs fall through to the full resolver below. Human/service
  // traffic is behaviorally untouched by Agent RBAC (spec §3.4).
  const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));
  if (!canAccessACL(tier)) {
    const bypassStep = {
      rule: "tier_gate",
      description: `tier:${tier} — non-enterprise org bypasses IAM resolver → allow`,
      decided: true,
      outcome: "allow" as const,
    };
    const bypassResult: ResolveResult = {
      outcome: "allow",
      trace: { steps: [bypassStep], decidedBy: bypassStep },
    };
    emitAudit({
      capability,
      ctx,
      principal: null,
      result: bypassResult,
      trace: bypassResult.trace,
      rawInputJson,
      target: target ?? null,
    }).catch((err: unknown) =>
      reportAuditEmissionFailure(capability, ctx, err),
    );
    return { result: bypassResult, principal: null };
  }

  // 1. Fetch authz data — falls back to empty if IAM tables are absent.
  const authz = await fetchAuthz({
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability,
  });

  const principal = authz.principal;

  // 2. Run the pure resolver.
  const resolveInput = {
    principal: principal ?? {
      id: "00000000-0000-0000-0000-000000000000",
      kind: "service" as const,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    capability,
    scope: {
      kind: (ctx.workspaceId ? "workspace" : "org") as "org" | "workspace",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    grants: authz.grants,
    roles: authz.roles,
    roleGrants: authz.roleGrants,
    policies: authz.policies,
    defaultEffect,
    // Thread the request timestamp and client IP so the condition evaluator
    // can enforce time_window and ip_ranges/ip_allow conditions.
    now: new Date(),
    clientIp: ctx.clientIp ?? null,
  };

  const result = resolve(resolveInput);

  // 3. Emit audit — fire-and-forget. Audit failures must be loud but NEVER
  // block the user path (see reportAuditEmissionFailure — OXA-2058).
  emitAudit({
    capability,
    ctx,
    principal,
    result,
    trace: result.trace,
    rawInputJson,
    target: target ?? null,
  }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));

  return { result, principal };
}

// ═════════════════════════════════════════════════════════════════════════════
// Agent-run branch (Agent RBAC Phase 2 — spec §3.4/§3.5)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * In-flight snapshot fetches, keyed BY THE RUN CONTEXT OBJECT so two
 * concurrent invoke()s of the same run share one fetch instead of racing two.
 * A WeakMap keyed on the per-run object is not module-global caching: entries
 * are scoped to (and garbage-collected with) their run — one run's grants can
 * never bleed into another's. The durable cache itself lives on
 * `agentRun.resolution` so tool materialization reads the SAME object.
 */
const inflightResolutions = new WeakMap<
  AgentRunIAMContext,
  Promise<AgentRunIAMResolution>
>();

/**
 * Get (or compute exactly once) the run's authz resolution. First caller
 * fetches the snapshot and writes `agentRun.resolution`; every later caller —
 * a second invoke() in the same run, or tool materialization — reuses it.
 * A failed fetch clears the in-flight slot so a transient DB error does not
 * poison the rest of the run with a permanently-rejected promise.
 */
async function resolutionForAgentRun(
  agentRun: AgentRunIAMContext,
  ctx: CapabilityContext,
): Promise<AgentRunIAMResolution> {
  if (agentRun.resolution !== undefined) return agentRun.resolution;
  let pending = inflightResolutions.get(agentRun);
  if (pending === undefined) {
    pending = fetchAgentRunAuthz({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentPrincipalId: agentRun.agentPrincipal.id,
      humanPrincipalId: agentRun.humanPrincipal?.id ?? null,
    }).then(createAgentRunResolution);
    inflightResolutions.set(agentRun, pending);
  }
  try {
    const resolution = await pending;
    agentRun.resolution = resolution;
    return resolution;
  } catch (err) {
    inflightResolutions.delete(agentRun);
    throw err;
  }
}

/**
 * Flatten an EffectivePermissions (the deny-wins merge of the agent's and the
 * invoking human's independent resolutions) into one ResolveResult for the
 * kernel and the audit row. decision_reason becomes
 * `agent_delegation:<outcome>` — a stable rule id disjoint from every human
 * resolver rule, so agent denials/escalations are directly meterable in the
 * audit stream (spec §5: "denials and approval escalations are meterable
 * events") on top of acting_principal_kind='agent'.
 */
function agentResolveResult(perms: EffectivePermissions): ResolveResult {
  const agentDecided = perms.agentResolution.trace.decidedBy;
  const humanDecided = perms.humanResolution.trace.decidedBy;
  const step: TraceStep = {
    rule: `agent_delegation:${perms.outcome}`,
    description:
      `agent ∩ invoking-human deny-wins merge — ` +
      `agent=${perms.agentResolution.outcome} (${agentDecided.rule}), ` +
      `human=${perms.humanResolution.outcome} (${humanDecided.rule})`,
    decided: true,
    outcome: perms.outcome,
  };
  const trace = { steps: [step], decidedBy: step };
  if (perms.outcome === "allow") return { outcome: "allow", trace };
  if (perms.outcome === "pending_approval") {
    // The kernel routes this through the SAME approval path human
    // require_approval outcomes take today: enforced pending_approval →
    // JIT access-request creation (setKernelAccessRequestCreator) → a
    // pollable CapabilityError(code="pending_approval", accessRequestId).
    return { outcome: "pending_approval", trace };
  }
  // Deny — surface the machine-readable reason from whichever side of the
  // ceiling denied (deny-wins guarantees at least one side did).
  const reason =
    perms.agentResolution.outcome === "deny"
      ? perms.agentResolution.reason
      : perms.humanResolution.outcome === "deny"
        ? perms.humanResolution.reason
        : "no_grant";
  return { outcome: "deny", reason, trace };
}

/**
 * Fail-closed result for an invocation that DECLARES principalKind='agent'
 * but carries no AgentRunIAMContext: without the two principals the
 * delegation ceiling cannot be resolved, and resolving as a human instead
 * would check the wrong principal entirely.
 */
function denyMissingAgentContext(args: CheckIAMArgs): CheckIAMResult {
  const { capability, ctx, rawInputJson, target } = args;
  const step: TraceStep = {
    rule: "agent_delegation:missing_context",
    description:
      "principalKind='agent' but ctx.agentRun is absent — the delegation " +
      "ceiling cannot be resolved; failing closed",
    decided: true,
    outcome: "deny",
  };
  const result: ResolveResult = {
    outcome: "deny",
    reason: "no_grant",
    trace: { steps: [step], decidedBy: step },
  };
  emitAudit({
    capability,
    ctx,
    principal: null,
    result,
    trace: result.trace,
    rawInputJson,
    target: target ?? null,
  }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));
  return { result, principal: null };
}

/**
 * The agent-run IAM check: resolve the delegation ceiling (agent ∩ invoking
 * human, deny-wins) against the run's cached snapshot — computed once per run
 * on first use — then audit with principal_kind='agent' and full run lineage.
 *
 * Unlike the human path this MAY throw (snapshot fetch failure, incl. missing
 * IAM tables): the kernel's IAM seam treats a check-fn throw as an evaluation
 * failure and fails closed unconditionally (OXA-2056), which is exactly the
 * posture an unattended automation requires.
 */
async function checkAgentRunIAM(
  args: CheckIAMArgs & { agentRun: AgentRunIAMContext },
): Promise<CheckIAMResult> {
  const { capability, ctx, defaultEffect, rawInputJson, target, agentRun } =
    args;

  const resolution = await resolutionForAgentRun(agentRun, ctx);

  const perms = resolveAgentRunCapability(agentRun, resolution, {
    capability,
    scope: {
      kind: (ctx.workspaceId ? "workspace" : "org") as "org" | "workspace",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    defaultEffect,
    now: new Date(),
    clientIp: ctx.clientIp ?? null,
  });

  const result = agentResolveResult(perms);

  // Audit — fire-and-forget, same OXA-2058 contract as the human path — with
  // the AGENT as acting principal (principal_kind='agent'), the delegating
  // human's principal id, and run lineage (agentId/runId/parentRunId, §5).
  emitAudit({
    capability,
    ctx,
    principal: agentRun.agentPrincipal,
    result,
    trace: result.trace,
    rawInputJson,
    target: target ?? null,
    humanPrincipalId: agentRun.humanPrincipal?.id ?? null,
    runLineage: {
      agentId: agentRun.agentId,
      runId: agentRun.runId,
      parentRunId: agentRun.parentRunId ?? null,
    },
  }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));

  return { result, principal: agentRun.agentPrincipal };
}
