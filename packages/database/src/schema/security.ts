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
//
// PARTITION MANAGEMENT:
//   The table is a RANGE-partitioned heap on occurred_at (monthly, DDL in
//   0002_security_events_partitioning.sql). The composite PK (id, occurred_at)
//   is required by Postgres declarative partitioning. Monthly child partitions
//   are created and expired by the `security.audit-partition-rollover` Inngest
//   cron (packages/inngest-functions). 7-year retention matches ClickHouse
//   audit_events TTL. DO NOT add event types here without also updating the
//   CHECK constraint DDL in the migration file.

import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  SECURITY_EVENT_TYPES,
  generateEventTypeCheckClause,
  generateOutcomeCheckClause,
} from "@oxagen/compliance";
import { securitySchema } from "./_schemas";

// ---------------------------------------------------------------------------
// SecurityEventType — typed const-union. SINGLE SOURCE: @oxagen/compliance.
// Add new event kinds in packages/compliance/src/security-event-types.ts; both
// this schema's CHECK constraint and the @oxagen/telemetry emit type derive
// from that one array. Re-exported here so existing `@oxagen/database/schema`
// importers keep working.
// ---------------------------------------------------------------------------

export { SECURITY_EVENT_TYPES };
export type { SecurityEventType } from "@oxagen/compliance";

// ---------------------------------------------------------------------------
// security.security_events
// ---------------------------------------------------------------------------

export const securityEvents = securitySchema.table(
  "security_events",
  {
    // Composite PK (id, occurred_at) is required by Postgres declarative
    // partitioning — the partition key must be included in every unique
    // constraint and primary key. id remains UUIDv4 so it is functionally
    // unique; occurred_at is the partition key. Not using idMixin because
    // append-only tables must NOT inherit updatedAt / updatedByUserId.
    id: uuid("id").notNull().default(sql`uuid_generate_v4()`),

    // When the event actually happened (caller-supplied for accurate
    // timestamps when events are emitted close to a transaction boundary).
    // Also the partition key — never null.
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    // Event classification. CHECK constraint mirrors the TS union so the DB
    // rejects an unknown value even if application code drifts.
    eventType: text("event_type").notNull(),

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
    // Composite PK: required by Postgres RANGE partitioning — partition key
    // (occurred_at) must be part of every unique constraint and primary key.
    pk: primaryKey({ columns: [t.id, t.occurredAt] }),

    // Compliance range queries: "show me all events for org X in period Y"
    orgOccurredIdx: index("security_events_org_occurred_idx").on(
      t.orgId,
      t.occurredAt,
    ),
    // Alert queries: "show me all denied invocations in the last hour"
    typeOccurredIdx: index("security_events_type_occurred_idx").on(
      t.eventType,
      t.occurredAt,
    ),
    // Session-expiry audit cron joins on request_id with no time bound
    // (2026-07-11 audit §4.1 item 6) — was an unindexed seq-scan over the
    // whole (monthly-growing) table.
    requestIdIdx: index("security_events_request_id_idx").on(t.requestId),

    // DB-level CHECK constraints to enforce the typed union and outcome set.
    // The clause bodies are generated from the @oxagen/compliance single source
    // (db-check.ts) so the schema, the emit type, and the migration DDL can
    // never drift. The column names match this table's physical columns.
    eventTypeCheck: check(
      "security_events_event_type_check",
      sql.raw(generateEventTypeCheckClause("event_type")),
    ),
    outcomeCheck: check(
      "security_events_outcome_check",
      sql.raw(generateOutcomeCheckClause("outcome")),
    ),
  }),
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;

// ---------------------------------------------------------------------------
// security.org_security_policy — org-level security configuration.
//
// One row per org (upsertable). Tracks MFA enforcement policy (CC6.1/CC6.2).
// The table is mutable (orgs can change policy) but all mutations are audited
// via security_events (security.mfa_policy_updated).
// ---------------------------------------------------------------------------

export const orgSecurityPolicy = securitySchema.table("org_security_policy", {
  orgId: uuid("org_id").primaryKey().notNull(),
  // When true, members who lack MFA are blocked from accessing org resources
  // after the grace period expires.
  mfaRequired: boolean("mfa_required").notNull().default(false),
  // How many hours a member can access the org after MFA is required before
  // they are forced to enroll. 0 = immediate enforcement.
  mfaGraceHours: integer("mfa_grace_hours").notNull().default(48),
  updatedByUserId: uuid("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export type OrgSecurityPolicy = typeof orgSecurityPolicy.$inferSelect;
export type NewOrgSecurityPolicy = typeof orgSecurityPolicy.$inferInsert;

// ---------------------------------------------------------------------------
// security.mcp_server_changes — append-only audit of external-MCP server
// enable / disable / delete events.
//
// Every lifecycle mutation of an external MCP server lands one immutable row
// here so an auditor can reconstruct who turned a server on/off or deleted it,
// and when — the retention job that purges tool-descriptor snapshots keys off
// the most recent `delete` row's occurred_at (>= 365 days).
//
// COMPLIANCE POLICY (mirrors security_events): NO updated_at / updated_by /
// deleted_at / deleted_by — rows are inserted once and never mutated. It is
// NOT a partitioned table (volume is tiny vs. security_events), so it uses a
// plain UUID primary key, but it stays in the `security` schema so the same
// append-only backup/permission posture applies.
// ---------------------------------------------------------------------------

export const mcpServerChanges = securitySchema.table(
  "mcp_server_changes",
  {
    // Append-only: not idMixin (which carries updatedAt via auditMixin). Just a
    // functionally-unique UUID PK.
    id: uuid("id").primaryKey().notNull().default(sql`uuid_generate_v4()`),

    // Scope. org_id always required; workspace_id always set for an MCP server
    // (servers are workspace-scoped via orgScopeMixin), so NOT NULL here too.
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),

    // The mcp.mcp_servers.id whose lifecycle changed. App-enforced reference
    // (cross-schema FKs stay app-enforced per the storage rules).
    serverId: uuid("server_id").notNull(),

    // What happened. CHECK constraint mirrors the TS union.
    changeType: text("change_type").notNull(), // enable | disable | delete | drift_detected

    // Who triggered it. Nullable — system/cron-driven changes have no actor.
    actorUserId: uuid("actor_user_id"),

    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Audit range queries: "show me all changes for org X in period Y".
    orgOccurredIdx: index("mcp_server_changes_org_occurred_idx").on(
      t.orgId,
      t.occurredAt,
    ),
    // Retention lookup: "the most recent delete for this server".
    serverChangeIdx: index("mcp_server_changes_server_idx").on(
      t.serverId,
      t.changeType,
      t.occurredAt,
    ),
    changeTypeCheck: check(
      "mcp_server_changes_change_type_check",
      sql`${t.changeType} IN ('enable','disable','delete','drift_detected')`,
    ),
  }),
);

export type McpServerChange = typeof mcpServerChanges.$inferSelect;
export type NewMcpServerChange = typeof mcpServerChanges.$inferInsert;
