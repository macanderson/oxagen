// privacy.ts — GDPR Art.17 (erasure) and Art.20 (portability) request tracking.
//
// These tables are the durable audit trail for every data export and erasure
// request. Both are purely transactional state — correct stores per CLAUDE.md.
//
// Append-only intent: rows are inserted and status-updated only.
// No deleted_at / deleted_by — the request record itself is the audit trail.

import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { privacySchema } from "./_schemas";
import { idMixin, auditMixin } from "./_mixins";

// ── Enums ────────────────────────────────────────────────────────────────────

export const privacyRequestScopeEnum = privacySchema.enum(
  "privacy_request_scope",
  ["user", "org"],
);

export const privacyExportStatusEnum = privacySchema.enum(
  "privacy_export_status",
  ["queued", "processing", "ready", "failed"],
);

export const privacyErasureStatusEnum = privacySchema.enum(
  "privacy_erasure_status",
  ["queued", "processing", "completed", "failed"],
);

// ── privacy_export_requests ──────────────────────────────────────────────────

export const privacyExportRequests = privacySchema.table(
  "privacy_export_requests",
  {
    ...idMixin("prexp"),
    ...auditMixin(),
    /** The user who submitted the export request. */
    userId: uuid("user_id").notNull(),
    /** Org context — always set; for user-scope exports this is their primary org. */
    orgId: uuid("org_id").notNull(),
    scope: privacyRequestScopeEnum("scope").notNull(),
    status: privacyExportStatusEnum("status").notNull().default("queued"),
    /** Signed Vercel Blob URL — set when status transitions to "ready". */
    exportUrl: text("export_url"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Error message if status = "failed". */
    errorMessage: text("error_message"),
  },
  (t) => ({
    userIdx: index("privacy_export_requests_user_idx").on(t.userId),
    orgIdx: index("privacy_export_requests_org_idx").on(t.orgId),
    statusCheck: check(
      "privacy_export_status_chk",
      sql`${t.status} IN ('queued','processing','ready','failed')`,
    ),
  }),
);

// ── privacy_erasure_requests ─────────────────────────────────────────────────

export const privacyErasureRequests = privacySchema.table(
  "privacy_erasure_requests",
  {
    ...idMixin("preras"),
    ...auditMixin(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    scope: privacyRequestScopeEnum("scope").notNull(),
    status: privacyErasureStatusEnum("status").notNull().default("queued"),
    /**
     * When the hard-delete is scheduled.
     * Configurable via PRIVACY_ERASURE_GRACE_DAYS (default 30).
     * Set to createdAt for immediate erasure (grace period = 0).
     */
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    errorMessage: text("error_message"),
  },
  (t) => ({
    userIdx: index("privacy_erasure_requests_user_idx").on(t.userId),
    orgIdx: index("privacy_erasure_requests_org_idx").on(t.orgId),
    statusCheck: check(
      "privacy_erasure_status_chk",
      sql`${t.status} IN ('queued','processing','completed','failed')`,
    ),
  }),
);
