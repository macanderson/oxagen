// emit-audit.ts — fire-and-forget IAM audit event emitter.
//
// Builds an AuditEventRow from the resolver trace + invocation context, reads
// the latest chain hash for (org_id, capability), and inserts into ClickHouse
// via @oxagen/telemetry. Called once per capability invocation, regardless of
// the resolver outcome.
//
// FIRE-AND-FORGET: the caller does not await this function. Failures are
// logged loudly — auditing failures are critical incidents — but they NEVER
// block the user's response path.
//
// HASH-CHAIN RACE: two concurrent calls for the same (org_id, capability) may
// read the same prev_hash. Chain verification is at the range level, not
// per-event ordering.
//
// An empty `chain_hash` breaks tamper-evidence for every subsequent row
// chained on top of it — a verifier cannot validate past an empty link.
// Both hash computations below (`payloadHash`, `chainHash`) therefore
// PROPAGATE a `sha256Hex` failure instead of swallowing it into `""`: this
// function refuses to write a degraded/corrupt audit row at all rather than
// silently persisting one. The insert itself is retried with backoff before
// the same "fail loudly, never swallow" rule applies to the DB write.
// Reading the PREVIOUS chain hash is a different, already-documented
// non-fatal case (see HASH-CHAIN RACE above): a read failure re-anchors the
// chain from an empty prevHash but still computes and persists a VALID
// (non-empty) chain_hash for this row — it never produces an empty string.

import {
  insertAuditEvent,
  latestAuditChainHash,
  retryWithBackoff,
  type AuditEventRow,
} from "@oxagen/telemetry";
import type { ResolveResult, Trace } from "@oxagen/oxagen/iam";
import type { CapabilityContext, ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

// Minimal crypto: SHA-256 hex of a string. Available in Node 16+ and browsers.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface EmitAuditArgs {
  capability: string;
  ctx: CapabilityContext;
  principal: ResolvedPrincipal | null;
  result: ResolveResult;
  trace: Trace;
  /** Serialized input for payload_hash — never store raw input, only its hash. */
  rawInputJson: string;
  /**
   * The object this invocation acts on (accountability chain) — recorded as
   * target_kind/target_id so "who touched object X" is queryable. Null when
   * the contract declares no audit target.
   */
  target?: { kind: string; id: string } | null;
  /**
   * When the ACTING principal is an agent: the delegating human principal it
   * acts on behalf of (Agent RBAC spec §5 — the delegation ceiling's other
   * half). Recorded as human_principal_id so "which human's authority did
   * this agent exercise" is queryable. Ignored when the acting principal is
   * itself human (the acting id already fills the column).
   */
  humanPrincipalId?: string | null;
  /**
   * Agent-run lineage (Agent RBAC spec §5): the agent's public id, the run,
   * and — for subagent dispatches — the parent run. `runId` lands in
   * correlation_id (correlating every capability check of one run); the full
   * lineage is embedded in trace_jsonb under `agentRun`.
   */
  runLineage?: {
    agentId: string;
    runId: string;
    parentRunId?: string | null;
  } | null;
}

/**
 * Emit an IAM audit event to ClickHouse. Fire-and-forget — callers must NOT
 * await this unless they are in a test or audit-critical path.
 *
 * Rejects (never silently drops) when either hash computation fails or the
 * durable insert (after retries) still fails — see the note at the top of
 * this file. Callers are expected to `.catch()` this and alert.
 */
export async function emitAudit(args: EmitAuditArgs): Promise<void> {
  const {
    capability,
    ctx,
    principal,
    result,
    trace,
    rawInputJson,
    target,
    humanPrincipalId,
    runLineage,
  } = args;
  const now = new Date().toISOString();
  const eventId = globalThis.crypto.randomUUID();

  // Determine scope from context.
  const scopeKind: "org" | "workspace" = ctx.workspaceId ? "workspace" : "org";
  const scopeId = scopeKind === "workspace" ? ctx.workspaceId : ctx.orgId;

  // Hash the input payload — we store a fingerprint, not the raw value. A
  // failure here is the same class of defect as an empty chain_hash: never
  // persist a degraded/empty fingerprint. Propagate so the caller's
  // fire-and-forget `.catch()` alerts loudly and no row is written.
  let payloadHash: string;
  try {
    payloadHash = await sha256Hex(rawInputJson);
  } catch (err) {
    logger.error(
      { err, capability },
      "[iam:emit-audit] sha256(payload) failed — refusing to persist a degraded audit row",
    );
    throw err;
  }

  // Read the previous chain hash — read failure is non-fatal: it re-anchors
  // the chain from an empty prevHash (documented HASH-CHAIN RACE risk above),
  // but still lets us COMPUTE a valid, non-empty chain_hash below. This is
  // different from the empty-chain_hash defect — that only happens if the
  // hash computation itself throws (handled next).
  let prevHash = "";
  try {
    prevHash = await latestAuditChainHash({
      orgId: ctx.orgId,
      capability,
    });
  } catch (err) {
    logger.warn(
      { err },
      "[iam:emit-audit] Failed to read latest chain hash — chaining from empty prevHash",
    );
  }

  // Compute this event's chain hash over (prev_hash || event_id || capability).
  // An empty chain_hash breaks tamper-evidence for every subsequent row in
  // the chain. NEVER persist one — if the hash can't be computed, refuse to
  // write the row at all instead of silently degrading the chain.
  const chainInput = `${prevHash}|${eventId}|${capability}`;
  let chainHash: string;
  try {
    chainHash = await sha256Hex(chainInput);
  } catch (err) {
    logger.error(
      { err, capability },
      "[iam:emit-audit] sha256(chain) failed — refusing to persist a row with an empty chain_hash",
    );
    throw err;
  }

  const outcome = result.outcome;
  const decisionReason = result.trace.decidedBy.rule;

  const actingPrincipalId =
    principal?.id ?? "00000000-0000-0000-0000-000000000000";
  const actingPrincipalKind: "human" | "agent" | "service" =
    principal?.kind ?? "service";

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
      actingPrincipalKind === "human"
        ? actingPrincipalId
        : (humanPrincipalId ?? null),
    outcome,
    decision_reason: decisionReason,
    // Accountability chain: what was acted on (from the contract's
    // declarative audit target) and from where (surface-extracted client IP,
    // already validated for IAM condition evaluation).
    target_kind: target?.kind ?? null,
    target_id: target?.id ?? null,
    payload_hash: payloadHash,
    chain_hash: chainHash,
    ip: ctx.clientIp ?? null,
    ua: null,
    request_id: ctx.requestId,
    // Agent runs correlate every capability check of one run via the run id
    // (Agent RBAC spec §5); non-agent invocations keep null as before.
    correlation_id: runLineage?.runId ?? null,
    trace_jsonb: JSON.stringify({
      steps: trace.steps,
      decidedBy: trace.decidedBy,
      ...(runLineage
        ? {
            agentRun: {
              agentId: runLineage.agentId,
              runId: runLineage.runId,
              parentRunId: runLineage.parentRunId ?? null,
            },
          }
        : {}),
    }),
  };

  // Durable write: retry transient ClickHouse failures with backoff before
  // giving up — a fire-and-forget audit write must not vanish on the first
  // blip. A still-failing insert propagates to the caller's `.catch()`,
  // which is expected to alert loudly (see check-iam.ts) — never silently
  // dropped.
  await retryWithBackoff(() => insertAuditEvent(row), {
    attempts: 3,
    baseDelayMs: 25,
  });
}
