// emit-audit.ts — fire-and-forget IAM audit event emitter (OXA-1390, Phase 3).
//
// Builds an AuditEventRow from the resolver trace + invocation context, reads
// the latest chain hash for (org_id, capability), and inserts into ClickHouse
// via @oxagen/telemetry. Called once per defineContract().invoke() call,
// regardless of the resolver outcome.
//
// FIRE-AND-FORGET: the caller does not await this function. Failures are
// logged loudly — auditing failures are critical incidents — but they NEVER
// block the user's response path.
//
// HASH-CHAIN RACE: two concurrent calls for the same (org_id, capability) may
// read the same prev_hash. This is documented in plan.md Phase 3 §Risks.
// Chain verification is at the range level, not per-event ordering.

import { insertAuditEvent, latestAuditChainHash, type AuditEventRow } from "@oxagen/telemetry";
import type { ResolveResult, Trace } from "@oxagen/oxagen/iam";
import type { CapabilityContext, ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

// Minimal crypto: SHA-256 hex of a string. Available in Node 16+ and browsers.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EmitAuditArgs {
  capability: string;
  ctx: CapabilityContext;
  principal: ResolvedPrincipal | null;
  result: ResolveResult;
  trace: Trace;
  /** Serialized input for payload_hash — never store raw input, only its hash. */
  rawInputJson: string;
}

/**
 * Emit an IAM audit event to ClickHouse. Fire-and-forget — callers must NOT
 * await this unless they are in a test or audit-critical path.
 */
export async function emitAudit(args: EmitAuditArgs): Promise<void> {
  const { capability, ctx, principal, result, trace, rawInputJson } = args;
  const now = new Date().toISOString();
  const eventId = globalThis.crypto.randomUUID();

  // Determine scope from context.
  const scopeKind: "org" | "workspace" = ctx.workspaceId ? "workspace" : "org";
  const scopeId = scopeKind === "workspace" ? ctx.workspaceId : ctx.orgId;

  // Hash the input payload — we store a fingerprint, not the raw value.
  const payloadHash = await sha256Hex(rawInputJson).catch((err) => {
    logger.error({ err, capability }, "[iam:emit-audit] sha256 failed — audit chain integrity degraded");
    return "";
  });

  // Read the previous chain hash — read failure is non-fatal.
  let prevHash = "";
  try {
    prevHash = await latestAuditChainHash({
      orgId: ctx.orgId,
      capability,
    });
  } catch (err) {
    logger.warn({ err }, "[iam:emit-audit] Failed to read latest chain hash");
  }

  // Compute this event's chain hash over (prev_hash || event_id || capability).
  const chainInput = `${prevHash}|${eventId}|${capability}`;
  const chainHash = await sha256Hex(chainInput).catch((err) => {
    logger.error({ err, capability }, "[iam:emit-audit] sha256 failed — audit chain integrity degraded");
    return "";
  });

  const outcome = result.outcome;
  const decisionReason = result.trace.decidedBy.rule;

  const actingPrincipalId = principal?.id ?? "00000000-0000-0000-0000-000000000000";
  const actingPrincipalKind: "human" | "agent" | "service" = principal?.kind ?? "service";

  const row: AuditEventRow = {
    occurred_at: now,
    event_id: eventId,
    org_id: ctx.orgId,
    workspace_id: ctx.workspaceId || null,
    capability,
    scope_kind: scopeKind,
    scope_id: scopeId,
    acting_principal_id: actingPrincipalId,
    acting_principal_kind: actingPrincipalKind,
    human_principal_id:
      actingPrincipalKind === "human" ? actingPrincipalId : null,
    outcome,
    decision_reason: decisionReason,
    target_kind: null,
    target_id: null,
    payload_hash: payloadHash,
    chain_hash: chainHash,
    ip: null,
    ua: null,
    request_id: ctx.requestId,
    correlation_id: null,
    trace_jsonb: JSON.stringify({
      steps: trace.steps,
      decidedBy: trace.decidedBy,
    }),
  };

  await insertAuditEvent(row);
}
