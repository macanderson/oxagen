// security.ts — append-only SOC2 audit surface.
//
// COMPLIANCE POLICY (do not relax):
//   - NO updated_at / updated_by / deleted_at / deleted_by columns.
//   - Rows are inserted once and never mutated or soft-deleted.
//   - The table lives in the `security` Postgres schema, separate from
//     operational data, so permissions and backups can be managed
//     independently.
//
// Every capability invocation, auth lifecycle event, and authz decision
// that touches org data lands here. Downstream: compliance reports,
// anomaly detection, SOC2 CC6/CC7 evidence.

import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { securitySchema } from "./_schemas";

// ---------------------------------------------------------------------------
// SecurityEventType — typed const-union. Add values here as new event kinds
// are wired up; keep in lexicographic order within each group.
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

// ---------------------------------------------------------------------------
// security.security_events
// ---------------------------------------------------------------------------

export const securityEvents = securitySchema.table(
  "security_events",
  {
    // Primary key — UUIDv4 is fine here; ordering by occurred_at already
    // provides the temporal sort. Not using idMixin because append-only
    // tables must NOT inherit updatedAt / updatedByUserId.
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),

    // When the event actually happened (caller-supplied for accurate
    // timestamps when events are emitted close to a transaction boundary).
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    // Event classification. CHECK constraint mirrors the TS union so the DB
    // rejects an unknown value even if application code drifts.
    eventType: text("event_type")
      .notNull(),

    // Who triggered the event. Nullable — some events fire before a user
    // session is established (e.g. failed sign-in with unknown email).
    actorUserId: uuid("actor_user_id"),

    // Scope. org_id always required. workspace_id nullable (org-level events
    // such as member_invited may not be tied to a specific workspace).
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),

    // Which capability was invoked (filled for capability.* events; null for
    // auth.* events).
    capability: text("capability"),

    // Authz outcome.
    outcome: text("outcome").notNull(),

    // Request metadata — stored for forensics; never log tokens, passwords,
    // or other secrets in these fields.
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
  },
  (t) => ({
    // Compliance range queries: "show me all events for org X in period Y"
    orgOccurredIdx: index("security_events_org_occurred_idx").on(t.orgId, t.occurredAt),
    // Alert queries: "show me all denied invocations in the last hour"
    typeOccurredIdx: index("security_events_type_occurred_idx").on(t.eventType, t.occurredAt),

    // DB-level CHECK constraints to enforce the typed union and outcome set.
    eventTypeCheck: check(
      "security_events_event_type_check",
      sql`${t.eventType} IN (${sql.raw(SECURITY_EVENT_TYPES.map((v) => `'${v}'`).join(", "))})`,
    ),
    outcomeCheck: check(
      "security_events_outcome_check",
      sql`${t.outcome} IN ('allow', 'deny', 'error', 'success')`,
    ),
  }),
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
