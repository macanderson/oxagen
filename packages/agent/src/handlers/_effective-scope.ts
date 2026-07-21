// _effective-scope.ts — read the run-constant effective resourceScope off an
// agent run's cached IAM resolution (Agent RBAC Phase 4b, spec §3.3).
//
// The kernel resolves the invoked capability BEFORE the handler runs, so a
// delegated run's `ctx.agentRun.resolution.byCapability` always holds at least
// one entry by the time a handler executes. `resourceScope` is run-constant —
// it is collected from the two principals' grants/roles plus the parent-run
// ceiling, none of which vary per capability (see collectResourceScope in
// packages/oxagen/src/iam/resolve.ts) — so ANY cached entry is an equivalent
// source. This mirrors packages/handlers' effective-graph-scope helper; the
// skills/agents dimensions enforced from here are pure allow-lists and need no
// per-handler intersection beyond what the resolver already did.
//
// Human / API-key / service invocations carry no `agentRun` → `undefined` →
// every consumer is a byte-identical pass-through.

import pino from "pino";
import { emitAudit } from "@oxagen/iam";
import type {
  EffectiveResourceScope,
  ResolveResult,
  TraceStep,
} from "@oxagen/oxagen/iam";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.scope" },
});

/** The run's effective resourceScope, or undefined when not an agent run. */
export function effectiveResourceScope(
  ctx: CapabilityContext,
): EffectiveResourceScope | undefined {
  const resolution = ctx.agentRun?.resolution;
  if (!resolution) return undefined;
  for (const entry of resolution.byCapability.values()) {
    return entry.resourceScope;
  }
  return undefined;
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
