// _effective-scope.ts — read the run-constant effective resourceScope off an
// agent run's cached IAM resolution (Agent RBAC Phase 4b, spec §3.3).
//
// `resourceScope` is run-constant — it is collected from the two principals'
// grants/roles plus the parent-run ceiling, none of which vary per capability
// (see collectResourceScope in packages/oxagen/src/iam/resolve.ts) — so ANY
// cached entry on `ctx.agentRun.resolution.byCapability` is an equivalent
// source. This mirrors packages/handlers' effective-graph-scope helper; the
// skills/agents dimensions enforced from here are pure allow-lists and need no
// per-handler intersection beyond what the resolver already did.
//
// ── Why the memo is not assumed to be populated ─────────────────────────────
//
// The agent seam (packages/iam's live-agent-run-authorization.ts) keys its
// own generation-scoped cache and never writes `byCapability`, so the memo
// can be empty when this handler runs. An empty memo would make every
// dimension gate here a silent pass-through — a WIDENING. So when the memo is
// empty we resolve an inert sentinel capability against the run's snapshot
// through the SAME pure resolver, exactly as mcp-rbac.ts does for the MCP
// dimension: same snapshot, one policy, no second fetch, no DB.
//
// Human / API-key / service invocations carry no `agentRun` → `undefined` →
// every consumer is a byte-identical pass-through.

import pino from "pino";
import { emitAudit } from "@oxagen/iam";
import {
  resolveAgentRunCapability,
  type EffectiveResourceScope,
  type ResolveResult,
  type TraceStep,
} from "@oxagen/oxagen/iam";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.scope" },
});

/**
 * Inert capability name used ONLY to pull the run-constant resourceScope out
 * of the resolver when no real capability has been memoized yet this run. No
 * contract carries this name, so the memo entry it leaves can never satisfy a
 * kernel check. Mirrors `MCP_SCOPE_SENTINEL_CAPABILITY` in ../runtime/mcp-rbac.
 */
export const RESOURCE_SCOPE_SENTINEL_CAPABILITY = "__run_resource_scope__";

/** The run's effective resourceScope, or undefined when not an agent run. */
export function effectiveResourceScope(
  ctx: CapabilityContext,
): EffectiveResourceScope | undefined {
  const agentRun = ctx.agentRun;
  const resolution = agentRun?.resolution;
  if (!agentRun || !resolution) return undefined;
  for (const entry of resolution.byCapability.values()) {
    return entry.resourceScope;
  }
  // Empty memo — resolve the sentinel rather than reporting "unrestricted".
  return resolveAgentRunCapability(agentRun, resolution, {
    capability: RESOURCE_SCOPE_SENTINEL_CAPABILITY,
    scope: {
      kind: ctx.workspaceId ? "workspace" : "org",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    // The sentinel's own allow/deny outcome is never read — only the
    // run-constant resourceScope. Deny is the conservative default.
    defaultEffect: "deny",
    clientIp: ctx.clientIp ?? null,
  }).resourceScope;
}

/**
 * Fire-and-forget IAM audit row for a resource-dimension denial (skills /
 * subagent refs — spec §5: every dimension's denials are meterable). The
 * acting principal is the run's agent principal; lineage rides trace_jsonb.
 */
export function auditScopeDenial(args: {
  ctx: CapabilityContext;
  capability: string;
  rule: string;
  description: string;
  rawInputJson: string;
  target?: { kind: string; id: string } | null;
}): void {
  const run = args.ctx.agentRun;
  if (!run) return;

  const step: TraceStep = {
    rule: args.rule,
    description: args.description,
    decided: true,
    outcome: "deny",
  };
  const result: ResolveResult = {
    outcome: "deny",
    // The nearest structured reason: the role's grants confer no access to
    // this resource-dimension value (skill slug / dispatch ref).
    reason: "no_grant",
    trace: { steps: [step], decidedBy: step },
  };

  emitAudit({
    capability: args.capability,
    ctx: args.ctx,
    principal: run.agentPrincipal,
    result,
    trace: result.trace,
    rawInputJson: args.rawInputJson,
    target: args.target ?? null,
    humanPrincipalId: run.humanPrincipal?.id ?? null,
    runLineage: {
      agentId: run.agentId,
      runId: run.runId,
      parentRunId: run.parentRunId ?? null,
    },
  }).catch((err: unknown) => {
    logger.error(
      { err, capability: args.capability, rule: args.rule },
      "agent scope-denial audit emission failed (fire-and-forget — response path unaffected)",
    );
  });
}
