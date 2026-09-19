// check-iam.ts — combines fetchAuthz + resolve + emitAudit.
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
  type AgentRunIAMContext,
  type AuthorizationDecisionRef,
  type ResolveResult,
  type TraceStep,
} from "@oxagen/oxagen/iam";
import { digestJcs } from "@oxagen/run-evidence";
import { resourceScopeDigestOf } from "./resource-scope";
import { fetchAuthz } from "./fetch-authz";
import {
  evaluateAgentRunAuthorization,
  type AgentRunAuthorizationResult,
} from "./live-agent-run-authorization";
import { emitAudit } from "./emit-audit";
import { resolveOrgTierDetailed, canAccessACL } from "@oxagen/billing";
import { captureError } from "@oxagen/telemetry";
import { logger } from "./logger";
import { readKeyScope } from "./machine-key-scope";
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/oxagen/cli-session";

/**
 * The identity a purpose-scoped API key's call is attributed to in EVIDENCE
 * (the audit row emitAudit writes) — never the creator it borrowed role
 * grants from.
 *
 * This is deliberately narrower than swapping `CheckIAMResult.principal`
 * outright. That value also becomes the kernel's `resolvedPrincipal`, which
 * feeds `runInTenantScope`'s `principalId` GUC — documented
 * (`packages/tenancy/src/scope.ts`) as a genuine `iam.principals.id`, which
 * RLS predicates may join against. An API key's own id is not a row in that
 * table, so returning it as the acting principal there would hand
 * downstream RLS a foreign key into nothing, not merely a differently-named
 * identity. Evidence has no such contract to keep: an audit row's
 * `acting_principal_id` is a label on a ClickHouse event, read by people and
 * exports, not joined against Postgres by anything in this path. So this
 * function's output is used for the audit call only, and the `principal`
 * `resolve()` matched role grants against — and that the kernel threads
 * onward for tenant scope — is untouched.
 *
 * `purpose` is null for a plain org key and for a `cli_session_v1` key — the
 * one purpose that IS a person's own credential (`resolveApiKey` resolves it
 * to the user who approved `oxagen login`, and a surface that carries that
 * answer puts it on `ctx.userId`, which is what `principal` already reflects
 * in that case). Every other purpose is a machine credential — a Tacho host,
 * its gateway, a Stella telemetry install — and this function is what keeps
 * `fetchAuthz` agreeing with `resolveOperatorUserId` (#3151): such a key
 * never acts for a person, so the record of what it did names the key, not
 * the human whose role grants decided whether it could.
 */
function machineAttributedPrincipal(
  ctx: CapabilityContext,
  principal: ResolvedPrincipal | null,
  purpose: string | null,
): ResolvedPrincipal | null {
  if (purpose === null || purpose === CLI_SESSION_SCOPE_PURPOSE) {
    return principal;
  }
  if (!ctx.apiKeyId) return principal;
  return {
    id: ctx.apiKeyId,
    kind: "service",
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
}

/**
 * An audit-emission failure (durable write exhausted its retries, or a hash
 * computation failed and emitAudit refused to persist a corrupt row — see
 * emit-audit.ts) must be observable beyond a log line nobody watches.
 * Escalates to ClickHouse `error_events` + optional alert webhook via
 * `captureError`, which is itself fire-and-forget and never throws.
 */
export function reportAuditEmissionFailure(
  capability: string,
  ctx: CapabilityContext,
  err: unknown,
  /**
   * Which decision path lost the row. Exported for the out-of-kernel guards in
   * `@oxagen/handlers`, which decide `export_data` and `erase_data` outside
   * `checkIAM` and whose rows would otherwise leave the governance record
   * silently: the same failure, and no reason for it to be reported less.
   */
  where = "iam:checkIAM",
): void {
  logger.error(
    { err, capability, where },
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
    context: `${where} — audit event emission failed after retries`,
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
  /**
   * The platform-created `azd_…` reference to the immutable
   * `iam.authorization_decisions` row this check persisted. Present for every
   * agent-run outcome; null on the human/service paths, which record their
   * decision in the ClickHouse audit stream rather than the governed-run
   * decision ledger.
   */
  decision?: AuthorizationDecisionRef | null;
}

/**
 * Run the full IAM check for a capability invocation:
 *   fetch authz data → resolve → emit audit (fire-and-forget).
 *
 * Returns the resolver result and the resolved principal so the handler
 * can record authoring metadata.
 *
 * ACL plan-tier gate: for a non-agent principal the org's plan tier is checked
 * first, for EVERY capability — not just the `iam.*` namespace. Non-enterprise
 * orgs (free / build / scale — see canAccessACL) do not configure explicit ACL
 * policies, so the resolver is bypassed and the request is ALLOWED regardless
 * of the contract's own `defaultEffect`. Any capability that must stay
 * Owner/Admin-only on those tiers therefore needs its own gate at the call
 * site; IAM will not supply one. Enterprise orgs run the full resolver, where
 * role grants and defaultEffect are enforced.
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
  // The tier gate decides whether the resolver runs at all, so it must fail
  // CLOSED — enforce — on a tier nothing established. `free` is both a real
  // tier and the hard default, and treating the default as a licence to bypass
  // meant an org with no organizations row got every capability allowed with
  // zero policy consulted (#1384). A caller-supplied `ctx.planTier` is taken as
  // established: the middleware resolved it through the same path.
  const resolution =
    ctx.planTier !== undefined
      ? { tier: ctx.planTier, established: true }
      : await resolveOrgTierDetailed(ctx.orgId);
  const tier = resolution.tier;
  if (resolution.established && !canAccessACL(tier)) {
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
    // A read to identify a purpose-scoped key, since the bypass branch's
    // "zero DB queries" is otherwise true. This is the tier most orgs run
    // on (#1384's comment above), and a gateway-forwarded call reaches it,
    // so this is exactly the path evidence must not attribute to an
    // enroller it never asked about — see machineAttributedPrincipal.
    // `readKeyScope` reads the one column `machineKeyDenial` already read
    // moments earlier for this same key in the caller's adapter
    // (`bootstrap.ts`); a second small read here, on the org's own plane, is
    // the cost of correct evidence and is bounded to API-key traffic only.
    const purpose = ctx.apiKeyId
      ? await readKeyScope(ctx.orgId, ctx.apiKeyId).then((scope) =>
          scope.kind === "purpose" ? scope.purpose : null,
        )
      : null;
    const bypassPrincipal = machineAttributedPrincipal(ctx, null, purpose);
    emitAudit({
      capability,
      ctx,
      principal: bypassPrincipal,
      result: bypassResult,
      trace: bypassResult.trace,
      rawInputJson,
      target: target ?? null,
    }).catch((err: unknown) =>
      reportAuditEmissionFailure(capability, ctx, err),
    );
    // The kernel's resolvedPrincipal is unchanged — this tier already
    // returns null there, and machineAttributedPrincipal's guard against
    // widening the tenant-scope contract only matters when there is a real
    // principal to protect from being overwritten with an apiKeyId.
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
  // block the user path (see reportAuditEmissionFailure).
  //
  // `resolve()` above already ran against `principal` — the creator a
  // purpose-scoped key inherits role grants from — and that decision is
  // unchanged by the line below. What changes is who the OUTCOME is written
  // down against: a purpose-scoped key's call is attributed to the
  // credential, never the creator, so the evidence for a gateway-forwarded
  // call never reads as the enrolling operator's own action (#3151).
  const auditPrincipal = machineAttributedPrincipal(
    ctx,
    principal,
    authz.apiKeyPurpose,
  );
  emitAudit({
    capability,
    ctx,
    principal: auditPrincipal,
    result,
    trace: result.trace,
    rawInputJson,
    target: target ?? null,
  }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));

  // `principal`, not `auditPrincipal` — the kernel threads this onward as
  // resolvedPrincipal for tenant scope (see machineAttributedPrincipal's
  // doc); only the audit row above gets the credential-attributed identity.
  return { result, principal };
}

// ═════════════════════════════════════════════════════════════════════════════
// Agent-run branch — pinned ceiling ∩ live authority
// (Agent RBAC spec §3.4/§3.5 + run-evidence spec §"Security and retention")
// ═════════════════════════════════════════════════════════════════════════════
//
// Every agent-run check:
//
//   - re-reads live principal/agent status, emergency denies, and the
//     deny-generation vector under one MVCC snapshot;
//   - re-evaluates the PINNED ceiling against its ORIGINAL expiries and
//     conditions, and intersects it with freshly resolved live authority;
//   - persists one immutable authorization_decisions row and returns its
//     reference.
//
// The only caching left is the run's LIVE cache, keyed by the generation vector
// it was computed under (see agentRunLiveCacheKey) — so it can never serve a
// decision that a suspension, revocation, or emergency deny has already
// invalidated.

/**
 * Digest this invocation's input for the decision row.
 *
 * Digests the raw JSON STRING rather than a canonicalized object graph on
 * purpose: real capability inputs contain floats (temperatures, thresholds),
 * and the canonical-JSON writer refuses non-integer numbers rather than risk a
 * platform-dependent float serialization inside a digest. The kernel produces
 * `rawInputJson` deterministically from the already-validated input, so
 * digesting the string is stable for identical inputs — which is the property
 * the decision row needs.
 */
function inputDigestOf(rawInputJson: string): string {
  return digestJcs(rawInputJson);
}

/**
 * Flatten a live authorization result into one ResolveResult for the kernel
 * and the audit row. `decision_reason` becomes `agent_ceiling:<outcome>` — a
 * stable rule id disjoint from every human resolver rule, so agent denials and
 * escalations stay directly meterable in the audit stream (spec §5) on top of
 * acting_principal_kind='agent'.
 */
function agentResolveResult(
  evaluation: AgentRunAuthorizationResult,
): ResolveResult {
  const step: TraceStep = {
    rule: `agent_ceiling:${evaluation.outcome}`,
    description:
      `pinned ceiling ∩ live authority (deny-wins) — ` +
      `reason=${evaluation.reason ?? "none"}, ` +
      `generation=${evaluation.denyGeneration.org}.${evaluation.denyGeneration.workspace}` +
      (evaluation.cached ? ", served from the run's live cache" : ""),
    decided: true,
    outcome: evaluation.outcome,
  };
  const trace = { steps: [step], decidedBy: step };
  if (evaluation.outcome === "allow") return { outcome: "allow", trace };
  if (evaluation.outcome === "pending_approval") {
    // Routed through the SAME approval path human require_approval outcomes
    // take: enforced pending_approval → JIT access-request creation
    // (setKernelAccessRequestCreator) → a pollable
    // CapabilityError(code="pending_approval", accessRequestId).
    return { outcome: "pending_approval", trace };
  }
  return { outcome: "deny", reason: denialReasonOf(evaluation), trace };
}

/**
 * Map a live deny reason onto the resolver's machine-readable denial reason.
 * Everything that is not a recognised grant-level denial reports `no_grant` —
 * the narrowest, least informative answer, which is the right default for a
 * value that crosses a trust boundary into an error message.
 */
function denialReasonOf(
  evaluation: AgentRunAuthorizationResult,
): "no_grant" | "expired" | "condition_failed" {
  switch (evaluation.reason) {
    case "pinned_expired":
      return "expired";
    case "emergency_deny":
    case "principal_suspended":
    case "principal_deleted":
    case "agent_disabled":
      // The authority existed; a live condition removed it. `condition_failed`
      // is the resolver's existing vocabulary for exactly that, so surfaces
      // need no new denial shape.
      return "condition_failed";
    default:
      return "no_grant";
  }
}

/**
 * Fail-closed result for an invocation that DECLARES principalKind='agent'
 * but carries no AgentRunIAMContext: without the two principals the delegation
 * ceiling cannot be resolved, and resolving as a human instead would check the
 * wrong principal entirely.
 */
function denyMissingAgentContext(args: CheckIAMArgs): CheckIAMResult {
  const { capability, ctx, rawInputJson, target } = args;
  const step: TraceStep = {
    rule: "agent_ceiling:missing_context",
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
  return { result, principal: null, decision: null };
}

/**
 * The agent-run IAM check.
 *
 * MAY throw only if the evaluator itself throws unexpectedly — every EXPECTED
 * failure (unreadable authority, unwritable decision row) is already converted
 * to a deny inside `evaluateAgentRunAuthorization`. The kernel treats a throw as
 * an evaluation failure and fails closed unconditionally, so both paths land
 * in the same place.
 */
async function checkAgentRunIAM(
  args: CheckIAMArgs & { agentRun: AgentRunIAMContext },
): Promise<CheckIAMResult> {
  const { capability, ctx, defaultEffect, rawInputJson, target, agentRun } =
    args;

  const evaluation = await evaluateAgentRunAuthorization({
    agentRun,
    capability,
    scope: {
      kind: (ctx.workspaceId ? "workspace" : "org") as "org" | "workspace",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    defaultEffect,
    requestId: ctx.requestId,
    inputDigest: inputDigestOf(rawInputJson),
    // The object this call acts on, from the contract's declared audit
    // target, digested the way set_kill_switch digests a target — so a
    // resource-scope emergency deny naming it refuses the call (#1261).
    resourceScopeDigest: target ? resourceScopeDigestOf(target) : null,
    operatorUserId: ctx.userId ?? null,
    clientIp: ctx.clientIp ?? null,
  });

  const result = agentResolveResult(evaluation);

  // Audit — fire-and-forget, same contract as the human path — with
  // the AGENT as acting principal (principal_kind='agent'), the initiating
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

  return {
    result,
    principal: agentRun.agentPrincipal,
    decision: evaluation.decision,
  };
}
