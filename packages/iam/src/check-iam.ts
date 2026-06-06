// check-iam.ts — combines fetchAuthz + resolve + emitAudit (OXA-1390, Phase 3).
//
// This is the single function that defineContract().invoke() calls. It:
//   1. Fetches authz data from Postgres (principal, grants, roles, policies).
//   2. Runs the pure resolver.
//   3. Emits an audit event fire-and-forget.
//   4. Returns the resolve result (which may include principal for the handler).
//
// If pending_approval: the caller (define-contract.ts) also calls
// createAccessRequest() before returning the DenialResponse.
//
// Plan-tier ACL gate (§entitlements):
//   For Enterprise-only capabilities (those whose defaultEffect is 'deny' and
//   whose capability name is in the ACL namespace), the gate resolves the org's
//   plan tier and bypasses ACL resolution to ALLOW for non-enterprise orgs —
//   there is nothing to enforce when the feature is not available. For
//   enterprise orgs the normal IAM resolution path runs so the capability can
//   be granted or denied per explicit policy.

import type { CapabilityContext, CapabilityEffect, ResolvedPrincipal } from "@oxagen/oxagen";
import { resolve, type ResolveResult } from "@oxagen/oxagen/iam";
import { fetchAuthz } from "./fetch-authz";
import { emitAudit } from "./emit-audit";
import { resolveOrgTier, canAccessACL } from "@oxagen/billing";

/**
 * Capabilities in the `iam.*` namespace manage grants, roles, and access
 * policies — the ACL feature set. Enterprise orgs have these features
 * available and their IAM tables are fully populated; non-Enterprise orgs
 * do not configure explicit ACL policies, so the resolver is bypassed and
 * the request is ALLOWED (role membership is sufficient).
 *
 * Use this to determine whether a capability name is in the ACL namespace.
 */
function isAclCapability(capability: string): boolean {
  return (
    capability.startsWith("iam.") ||
    capability.startsWith("billing.acl.") ||
    capability === "iam"
  );
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

  // ── Plan-tier ACL gate ──────────────────────────────────────────────────────
  // For ACL-namespace capabilities, resolve the org's tier. Non-enterprise
  // orgs bypass the resolver and are ALLOWED (they have no ACL policies to
  // enforce — role membership is their access model). Enterprise orgs fall
  // through to the full resolver below.
  if (isAclCapability(capability)) {
    const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));
    if (!canAccessACL(tier)) {
      // Non-enterprise org: ACL policies don't apply. Allow and return an
      // 'allow' trace without running the resolver so non-enterprise role
      // members can still reach the (simpler) ACL-adjacent features.
      const bypassStep = {
        rule: "tier_gate",
        description: `tier:${tier} — non-enterprise org bypasses ACL resolver → allow`,
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
      }).catch((err: unknown) => {
        console.error("[iam:audit] CRITICAL — audit event emission failed:", err);
      });
      return { result: bypassResult, principal: null };
    }
    // Enterprise org: fall through to the full resolver.
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

  // 3. Emit audit — fire-and-forget.
  emitAudit({
    capability,
    ctx,
    principal,
    result,
    trace: result.trace,
    rawInputJson,
  }).catch((err: unknown) => {
    // Audit failures must be loud but NEVER block the user path.
    console.error("[iam:audit] CRITICAL — audit event emission failed:", err);
  });

  return { result, principal };
}
