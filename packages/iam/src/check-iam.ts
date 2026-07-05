// check-iam.ts — combines fetchAuthz + resolve + emitAudit (OXA-1390, Phase 3).
//
// Non-enterprise orgs receive an unconditional allow (zero DB queries, zero
// latency). Enterprise orgs run the full resolver: fetchAuthz → resolve →
// emitAudit.

import type { CapabilityContext, CapabilityEffect, ResolvedPrincipal } from "@oxagen/oxagen";
import { resolve, type ResolveResult } from "@oxagen/oxagen/iam";
import { fetchAuthz } from "./fetch-authz";
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
  logger.error({ err, capability }, "[iam:audit] CRITICAL — audit event emission failed");
  captureError({
    error: err,
    source: "api",
    severity: "error",
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability,
    requestId: ctx.requestId,
    context: "iam:checkIAM — audit event emission failed after retries (OXA-2058)",
  });
}

export interface CheckIAMArgs {
  capability: string;
  ctx: CapabilityContext;
  defaultEffect: CapabilityEffect;
  /** Serialized raw input for the audit payload hash. */
  rawInputJson: string;
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
  const { capability, ctx, defaultEffect, rawInputJson } = args;

  // ── Non-enterprise fast-path ────────────────────────────────────────────────
  // Non-enterprise orgs have no IAM policies to enforce. Skip the resolver
  // entirely and return allow — zero DB queries, zero latency cost.
  // Enterprise orgs fall through to the full resolver below.
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
    }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));
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
  }).catch((err: unknown) => reportAuditEmissionFailure(capability, ctx, err));

  return { result, principal };
}
