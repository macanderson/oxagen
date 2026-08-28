// security.ts — transport-agnostic write helper for the security_events
// audit surface (SOC2 CC6/CC7).
//
// Design invariants:
//   - Zero dependency on @oxagen/auth. Auth lifecycle emits are wired
//     externally (better-auth hooks in packages/auth) with a db reference
//     the auth package already holds.
//   - The `db` parameter accepts any object that satisfies the `AuditDb`
//     interface — the actual @oxagen/database db() singleton works, as do
//     Drizzle mock objects in tests.
//   - Never log secrets, tokens, hashed passwords, or raw PII into any
//     field. `ip` and `user_agent` are allowed (network metadata), but
//     do NOT store email addresses or usernames in `SecurityEventInput`.
//
// This file makes no direct db() call. All writes go through the
// AuditInsertFn injected at call time. The real inserter
// (makeSecurityEventInserter in @oxagen/database/security) uses a raw
// Database instance on purpose: an audit write must succeed even on a
// no_tenant_scope deny, since the kernel emits capability.invoke_denied for
// orgId:"" paths before a scope is ever established. Wrapping the insert in
// withTenantDb would lose that audit record, so do NOT wrap the
// AuditInsertFn or makeSecurityEventInserter in withTenantDb.
//
// Shared taxonomy: SECURITY_EVENT_TYPES, SecurityEventType, and SecurityOutcome
// are owned by @oxagen/compliance (the single source of truth). They are
// re-exported here so callers that only depend on @oxagen/telemetry don't need
// to import from @oxagen/compliance as well. @oxagen/database derives its CHECK
// constraint from the same source, so the emit type and the DB can never drift.

import {
  SECURITY_EVENT_TYPES,
  type SecurityEventType,
  type SecurityOutcome,
} from "@oxagen/compliance";
import { captureError } from "./error-reporting";
import { retryWithBackoff } from "./retry";

export { SECURITY_EVENT_TYPES };
export type { SecurityEventType, SecurityOutcome };

// ---------------------------------------------------------------------------
// SecurityEventInput — the caller-facing shape. Fields mirror the table
// columns in database/src/schema/security.ts.
// ---------------------------------------------------------------------------

export interface SecurityEventInput {
  /** ISO timestamp. Defaults to now() on the DB if omitted. */
  occurredAt?: Date;
  eventType: SecurityEventType;
  /** UUID of the acting user; null when no session exists (e.g. failed sign-in). */
  actorUserId: string | null;
  /** Always required — every event belongs to an org. */
  orgId: string;
  /** Null for org-level events that span all workspaces. */
  workspaceId: string | null;
  /** Filled for capability.* events; null for auth.* events. */
  capability: string | null;
  outcome: SecurityOutcome;
  /** Caller IP. Do NOT store tokens or passwords here. */
  ip: string | null;
  /** Raw User-Agent header. */
  userAgent: string | null;
  /** Idempotency / correlation key from the HTTP request. */
  requestId: string | null;
}

// ---------------------------------------------------------------------------
// Minimal DB abstraction. The @oxagen/database db() singleton satisfies this
// interface, as does any Drizzle NodePgDatabase with the security schema
// loaded. Using a structural type keeps @oxagen/telemetry dep-free from
// @oxagen/database at the package.json level.
// ---------------------------------------------------------------------------

export interface AuditInsertFn {
  (row: SecurityEventInput): Promise<void>;
}

/**
 * Attempts to persist `event` via `insert`, retrying transient failures with
 * exponential backoff before giving up. Shared by the fire-and-forget and
 * awaitable variants below so both get the same durability guarantee.
 */
function insertWithRetry(
  insert: AuditInsertFn,
  event: SecurityEventInput,
): Promise<void> {
  return retryWithBackoff(() => insert(event), {
    attempts: 3,
    baseDelayMs: 25,
  });
}

/**
 * Escalates an audit-write failure to durable, alertable telemetry — a
 * dropped security-audit row is a SOC2-relevant silent failure, so it must
 * be observable beyond a stderr line nobody watches. `captureError`
 * writes to ClickHouse `error_events` and (when configured) an outbound
 * alert webhook; it is itself fire-and-forget and never throws.
 *
 * Never expand `event` beyond eventType/orgId/workspaceId/capability/requestId
 * here — it may carry ip / user_agent, which must not be duplicated into the
 * error-reporting pipeline.
 */
function escalateWriteFailure(event: SecurityEventInput, err: unknown): void {
  captureError({
    error: err,
    // SecurityEventInput does not carry a runtime/surface tag (callers span
    // apps/app, apps/api, apps/mcp, and handlers invoked from all three), so
    // "api" is a coarse-but-consistent default for triage grouping — the
    // fingerprint + capability + eventType fields carry the real signal.
    source: "api",
    severity: "error",
    orgId: event.orgId,
    workspaceId: event.workspaceId,
    capability: event.capability,
    requestId: event.requestId,
    context: `security-audit: failed to durably write event (eventType=${event.eventType}) after retries exhausted`,
  });
}

/**
 * `recordSecurityEvent` — fire-and-forget insert of one audit row, durable
 * against transient failures.
 *
 * The insert is retried with exponential backoff (see `insertWithRetry`)
 * before being treated as failed. Once every attempt is exhausted, the
 * failure is (1) escalated to `captureError` — ClickHouse `error_events` +
 * optional alert webhook, so a dropped audit write stays observable — and
 * (2) forwarded to the optional `onError` callback / default stderr line.
 * Neither path re-throws: the capability invocation or auth action must
 * succeed even when the audit write is durably failing, but the failure
 * itself is never silently swallowed.
 *
 * @param insert  - A function that persists the row. Wire the real DB insert
 *                  via `makeSecurityEventInserter(db)` from @oxagen/database;
 *                  pass a mock in tests.
 * @param event   - The event to record.
 * @param onError - Optional error handler. Defaults to a structured JSON write
 *                  to process.stderr that includes no PII from the event
 *                  (only eventType + orgId).
 */
export function recordSecurityEvent(
  insert: AuditInsertFn,
  event: SecurityEventInput,
  onError?: (err: unknown) => void,
): void {
  insertWithRetry(insert, event).catch((err: unknown) => {
    escalateWriteFailure(event, err);

    if (onError) {
      onError(err);
    } else {
      // Default: log enough to triage without emitting PII. Do NOT expand
      // `event` here — it may contain ip / user_agent. Uses structured JSON
      // to stderr to match the rest of the telemetry package (no pino dep
      // in @oxagen/telemetry; process.stderr.write keeps the output
      // machine-readable without adding a dependency). This is a second,
      // local signal alongside the captureError escalation above.
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "security-audit: failed to write event after retries exhausted",
          eventType: event.eventType,
          orgId: event.orgId,
          err: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    }
  });
}

/**
 * `recordSecurityEventAsync` — awaitable variant for callers that need to
 * confirm the write before proceeding (e.g. tests, or places where the audit
 * record is load-bearing for compliance evidence).
 *
 * Retries transient failures the same way as `recordSecurityEvent`. If every
 * attempt still fails, the failure is escalated via `captureError` (so it is
 * observable even for callers that only check the rejection) and then
 * re-thrown — the awaiting caller opted into knowing the write failed.
 */
export async function recordSecurityEventAsync(
  insert: AuditInsertFn,
  event: SecurityEventInput,
): Promise<void> {
  try {
    await insertWithRetry(insert, event);
  } catch (err) {
    escalateWriteFailure(event, err);
    throw err;
  }
}
