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
// Shared type: SecurityEventType and SECURITY_EVENT_TYPES also live in
// packages/database/src/schema/security.ts. They are re-exported here so
// callers that only depend on @oxagen/telemetry don't need to import from
// @oxagen/database as well.

// ---------------------------------------------------------------------------
// SecurityEventType — typed const-union (mirror of the DB CHECK constraint).
// Keep in sync with database/src/schema/security.ts and the migration SQL.
// ---------------------------------------------------------------------------

export const SECURITY_EVENT_TYPES = [
  // Auth lifecycle
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.sign_out",
  "auth.token_refreshed",
  "auth.password_changed",
  "auth.email_verified",
  // API key lifecycle
  "api_key.created",
  "api_key.revoked",
  "api_key.used",
  // Capability authz
  "capability.invoke_allowed",
  "capability.invoke_denied",
  "capability.invoke_error",
  // Admin / org management
  "org.member_invited",
  "org.member_removed",
  "org.role_changed",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export type SecurityOutcome = "allow" | "deny" | "error" | "success";

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
 * `recordSecurityEvent` — fire-and-forget insert of one audit row.
 *
 * Errors are caught and forwarded to the optional `onError` callback so that
 * an audit failure never surfaces to the caller as an unhandled rejection
 * (the capability invocation or auth action must succeed even when the audit
 * write is temporarily degraded).
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
  insert(event).catch((err: unknown) => {
    if (onError) {
      onError(err);
    } else {
      // Default: log enough to triage without emitting PII. Do NOT expand
      // `event` here — it may contain ip / user_agent. Uses structured JSON
      // to stderr to match the rest of the telemetry package (no pino dep
      // in @oxagen/telemetry; process.stderr.write keeps the output
      // machine-readable without adding a dependency).
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "security-audit: failed to write event",
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
 */
export async function recordSecurityEventAsync(
  insert: AuditInsertFn,
  event: SecurityEventInput,
): Promise<void> {
  await insert(event);
}
