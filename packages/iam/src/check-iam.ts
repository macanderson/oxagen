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

import type { CapabilityContext, CapabilityEffect, ResolvedPrincipal } from "@oxagen/oxagen";
import { resolve, type ResolveResult } from "@oxagen/oxagen/iam";
import { fetchAuthz } from "./fetch-authz.js";
import { emitAudit } from "./emit-audit.js";

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
 */
export async function checkIAM(args: CheckIAMArgs): Promise<CheckIAMResult> {
  const { capability, ctx, defaultEffect, rawInputJson } = args;

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
