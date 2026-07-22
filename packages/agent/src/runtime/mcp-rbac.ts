// mcp-rbac.ts — Agent RBAC Phase 4a: per-tool-call MCP rule enforcement
// (docs/specs/agent-rbac/spec.md §3.7).
//
// A role's resourceScope.mcp carries first-match-wins "server:tool" glob
// rules ({ pattern, effect: allow|deny|ask }). This module is the runtime MCP
// bridge's half of the ONE shared evaluation engine:
//
//   - the rule evaluation itself is @oxagen/oxagen/iam's
//     `evaluateEffectiveMcpScope` / `mcpServerToolKey` — the exact functions
//     the resolver uses to combine intersected ceilings, and the same engine
//     apply-agent-binding.ts (apps/app) evaluates for the binding-time server
//     intersection (`mcpServerFullyDenied`). No second matcher exists on this
//     path; glob semantics parity with packages/mcp-config's `matchGlob` is
//     pinned by the witness test co-located with this module.
//   - the effective scope is read from the run's ONE cached IAM resolution
//     (ctx.agentRun.resolution — spec §3.5), mirroring how
//     packages/handlers/src/lib/effective-graph-scope.ts reads the graph
//     dimension: resourceScope is run-constant (collected from the
//     principals' grants/roles, never per-capability), so any cached
//     per-capability entry carries it; when none is cached yet we resolve a
//     sentinel capability against the SAME snapshot via the SAME pure
//     resolver, never a second fetch.
//
// Deny/ask outcomes are audited through packages/iam's `emitAudit` with the
// agent as the acting principal (principal_kind='agent') and the
// "server:tool" identifier as the audit target dimension.

import pino from "pino";
import { emitAudit } from "@oxagen/iam";
import {
  evaluateEffectiveMcpScope,
  mcpServerToolKey,
  resolveAgentRunCapability,
  type AgentRunIAMContext,
  type AgentRunIAMResolution,
  type EffectiveMcpScope,
  type McpRuleEffect,
  type ResolveScope,
  type ResolveResult,
  type TraceStep,
} from "@oxagen/oxagen/iam";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp-rbac" },
});

/**
 * Sentinel capability name used ONLY to pull the run-constant resourceScope
 * out of the resolver when no real capability has been resolved yet this run
 * (e.g. a turn whose capability-tool allowlist excluded everything). Resolved
 * through `resolveAgentRunCapability` against the run's cached snapshot —
 * same snapshot, same pure resolver, one policy (§3.5). The memoized entry is
 * inert for the kernel: no contract carries this name.
 */
export const MCP_SCOPE_SENTINEL_CAPABILITY = "__mcp_resource_scope__";

/**
 * Resolve the run's effective MCP rule scope from its cached IAM resolution.
 * Returns `undefined` when the run is unrestricted on the MCP dimension (no
 * rules anywhere in the ceiling) — the caller then applies no rule gate,
 * matching the "undefined = unrestricted" resourceScope convention.
 *
 * Callers MUST have already handled the fail-closed case (agentRun present
 * without a populated resolution) — this function requires the resolution.
 */
export function effectiveMcpScopeForRun(
  agentRun: AgentRunIAMContext,
  resolution: AgentRunIAMResolution,
  scope: ResolveScope,
  now: Date,
  clientIp: string | null,
): EffectiveMcpScope | undefined {
  // resourceScope is run-constant across capabilities (collectResourceScope
  // filters by principal only) — any cached entry is an equivalent source,
  // exactly like effective-graph-scope.ts's cachedPermissions.
  for (const entry of resolution.byCapability.values()) {
    return entry.resourceScope.mcp;
  }
  const perms = resolveAgentRunCapability(agentRun, resolution, {
    capability: MCP_SCOPE_SENTINEL_CAPABILITY,
    scope,
    // The sentinel's own allow/deny outcome is never read — only the
    // run-constant resourceScope. Deny is the conservative default.
    defaultEffect: "deny",
    now,
    clientIp,
  });
  return perms.resourceScope.mcp;
}

/**
 * Decide the effect of the run's MCP rules for one (serverName, toolName)
 * call. `undefined` scope → "allow" (unrestricted). The server segment of the
 * rule key is the server NAME (lowercased by mcpServerToolKey — rule patterns
 * address servers by lowercase name, e.g. "github:*"), never the row uuid.
 */
export function decideMcpToolEffect(
  scope: EffectiveMcpScope | undefined,
  serverName: string,
  toolName: string,
): McpRuleEffect {
  return evaluateEffectiveMcpScope(
    scope,
    mcpServerToolKey(serverName, toolName),
  );
}

export interface McpRuleAuditArgs {
  ctx: CapabilityContext;
  agentRun: AgentRunIAMContext;
  /** Synthetic capability id, e.g. `mcp.<serverId>.<tool>`. */
  capability: string;
  /** The evaluated "server:tool" rule key — the audit target dimension. */
  serverTool: string;
  /** The rule outcome being audited: a hard denial or an ask-escalation. */
  effect: "deny" | "ask";
}

/**
 * Emit the existing IAM audit event for an MCP rule denial or ask-escalation
 * (spec §5: "Every resolution outcome … emits the existing IAM audit event
 * with principal_kind, agent_id, run_id, capability, and dimension"). The
 * acting principal is the AGENT principal (→ acting_principal_kind='agent'),
 * the delegating human rides humanPrincipalId, run lineage lands in
 * correlation_id/trace_jsonb, and the server:tool key is the target
 * dimension. Fire-and-forget — an audit failure is logged loudly but never
 * blocks (or unblocks) the tool call; the deny itself already happened.
 */
export function emitMcpRuleAudit(args: McpRuleAuditArgs): void {
  const { ctx, agentRun, capability, serverTool, effect } = args;
  const outcome = effect === "deny" ? "deny" : "pending_approval";
  const step: TraceStep = {
    rule: "agent_rbac_mcp_rule",
    description: `resourceScope.mcp rules resolved "${effect}" for ${serverTool}`,
    decided: true,
    outcome,
  };
  const trace = { steps: [step], decidedBy: step };
  const result: ResolveResult =
    effect === "deny"
      ? // The rule ceiling rides the grant's conditions payload
        // (resourceScope), so condition_failed is the honest deny reason.
        { outcome: "deny", reason: "condition_failed", trace }
      : { outcome: "pending_approval", trace };

  emitAudit({
    capability,
    ctx,
    principal: agentRun.agentPrincipal,
    result,
    trace,
    // The rule key is the decision input — hash it, never the tool payload
    // (the tool input already rides tool_invocations telemetry).
    rawInputJson: JSON.stringify({ serverTool }),
    target: { kind: "mcp_tool", id: serverTool },
    humanPrincipalId: agentRun.humanPrincipal?.id ?? null,
    runLineage: {
      agentId: agentRun.agentId,
      runId: agentRun.runId,
      parentRunId: agentRun.parentRunId ?? null,
    },
  }).catch((err: unknown) => {
    logger.error(
      { err, capability, serverTool, effect },
      "[agent-rbac] MCP rule audit emit failed — decision already enforced, audit row missing (alert)",
    );
  });
}
