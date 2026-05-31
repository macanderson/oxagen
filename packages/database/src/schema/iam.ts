// iam.ts — IAM data layer (OXA-1389, Phase 2).
//
// All 7 IAM tables live in the `org` Postgres schema — no separate `iam`
// schema. The `org` schema is already in drizzle.config.ts's schemaFilter so
// these tables are picked up automatically by `drizzle-kit generate`.
//
// CRITICAL: Do NOT use orgScopeMixin() on these tables. orgScopeMixin() forces
// workspace_id NOT NULL, but principals/roles/role_grants are org-scoped
// entities that may not carry a workspace_id. All IAM tables declare their
// scope columns inline.
//
// Naming conventions (spec §4.3 public-id prefixes):
//   principals   → prn_
//   roles        → rol_
//   role_grants  → rlg_
//   grants       → grn_
//   policies     → pol_
//   access_requests → arq_
//   sessions (IAM) → ses_   (distinct from auth.sessions, export as iamSessions)
//
// Append-only rules:
//   sessions — no updated_at/updated_by (sessions are append-leaning;
//   revocation is tracked via revoked_at/revoked_by, never UPDATE).

import { check, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgSchema } from "./_schemas.js";
import { auditMixin, idMixin } from "./_mixins.js";

// ---------------------------------------------------------------------------
// principals — every human, agent, or service in the system
// ---------------------------------------------------------------------------

export const principals = orgSchema.table(
  "principals",
  {
    ...idMixin("prn"),
    ...auditMixin(),
    // org scope — all principals belong to exactly one org.
    orgId: uuid("org_id").notNull(),
    // workspace scope — nullable; a principal may be org-level only (e.g. a
    // billing service account) or workspace-scoped (a workspace-local agent).
    workspaceId: uuid("workspace_id"),
    // CHECK: kind IN ('human','agent','service')
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    // CHECK: status IN ('active','suspended','deleted')
    status: text("status").notNull().default("active"),
    // MFA lifecycle — 'none' | 'pending' | 'enrolled' | 'bypass'
    mfaStatus: text("mfa_status").notNull().default("none"),
    // Link to the identity provider subject (e.g. OAuth sub, SSO nameId).
    idpSubject: text("idp_subject"),
    // For delegated agents: the human principal they act on behalf of.
    parentUserId: uuid("parent_user_id"),
    // JSON metadata bag (provider-specific, not schema'd here).
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orgKindIdx: index("principals_org_kind_idx").on(t.orgId, t.kind),
    workspaceIdx: index("principals_workspace_idx").on(t.workspaceId),
    idpSubjectIdx: index("principals_idp_subject_idx").on(t.idpSubject),
    kindCheck: check(
      "principals_kind_check",
      sql`${t.kind} IN ('human', 'agent', 'service')`,
    ),
    statusCheck: check(
      "principals_status_check",
      sql`${t.status} IN ('active', 'suspended', 'deleted')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// roles — role definitions, system + custom, versioned
// ---------------------------------------------------------------------------

export const roles = orgSchema.table(
  "roles",
  {
    ...idMixin("rol"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    // CHECK: scope_kind IN ('org','workspace')
    scopeKind: text("scope_kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // true for system-seeded roles (Owner, Admin, etc.) — not user-deletable.
    isSystemDefault: text("is_system_default").notNull().default("false"),
    version: text("version").notNull().default("1"),
    parentRoleId: uuid("parent_role_id"),
  },
  (t) => ({
    orgNameIdx: index("roles_org_name_idx").on(t.orgId, t.name),
    scopeKindCheck: check(
      "roles_scope_kind_check",
      sql`${t.scopeKind} IN ('org', 'workspace')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// role_grants — role → capability mapping with an effect
// ---------------------------------------------------------------------------

export const roleGrants = orgSchema.table(
  "role_grants",
  {
    ...idMixin("rlg"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    roleId: uuid("role_id").notNull(),
    // Capability identifier string (e.g. "organization.create").
    // Not a FK — capability metadata lives on the contract objects, not a DB
    // table. Phase 3 (OXA-1390) will validate this at write time.
    capabilityId: text("capability_id").notNull(),
    // CHECK: effect IN ('allow','deny','require_approval')
    effect: text("effect").notNull(),
  },
  (t) => ({
    // Hot path: "what effect does this role have on this capability?"
    roleCapabilityIdx: index("role_grants_role_capability_idx").on(t.roleId, t.capabilityId),
    orgIdx: index("role_grants_org_idx").on(t.orgId),
    effectCheck: check(
      "role_grants_effect_check",
      sql`${t.effect} IN ('allow', 'deny', 'require_approval')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// grants — direct principal → capability grants (not via role)
// ---------------------------------------------------------------------------

export const grants = orgSchema.table(
  "grants",
  {
    ...idMixin("grn"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    // CHECK: scope_kind IN ('org','workspace')
    scopeKind: text("scope_kind").notNull(),
    // The specific org or workspace UUID this grant is scoped to.
    scopeId: uuid("scope_id").notNull(),
    // CHECK: effect IN ('allow','deny','require_approval')
    effect: text("effect").notNull(),
    conditionsJsonb: jsonb("conditions_jsonb"),
    grantedBy: uuid("granted_by"),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Resolver hot path: "what grants does principal X have in scope S?"
    principalScopeIdx: index("grants_principal_scope_idx").on(t.principalId, t.scopeId),
    capabilityIdx: index("grants_capability_idx").on(t.capabilityId),
    effectCheck: check(
      "grants_effect_check",
      sql`${t.effect} IN ('allow', 'deny', 'require_approval')`,
    ),
    scopeKindCheck: check(
      "grants_scope_kind_check",
      sql`${t.scopeKind} IN ('org', 'workspace')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// policies — conditional grants with enforcement flag + sensitivity tags
// ---------------------------------------------------------------------------

export const policies = orgSchema.table(
  "policies",
  {
    ...idMixin("pol"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    capabilityId: text("capability_id").notNull(),
    // CHECK: scope_kind IN ('org','workspace')
    scopeKind: text("scope_kind").notNull(),
    scopeId: uuid("scope_id"),
    // CHECK: effect IN ('allow','deny','require_approval')
    effect: text("effect").notNull(),
    // When true this policy is hard-enforced and cannot be overridden by a
    // lower-precedence grant. Analogous to an IAM "deny policy" in cloud IAM.
    enforced: text("enforced").notNull().default("false"),
    conditionsJsonb: jsonb("conditions_jsonb"),
    sensitivityTag: text("sensitivity_tag"),
  },
  (t) => ({
    orgCapabilityIdx: index("policies_org_capability_idx").on(t.orgId, t.capabilityId),
    effectCheck: check(
      "policies_effect_check",
      sql`${t.effect} IN ('allow', 'deny', 'require_approval')`,
    ),
    scopeKindCheck: check(
      "policies_scope_kind_check",
      sql`${t.scopeKind} IN ('org', 'workspace')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// access_requests — JIT access requests
// ---------------------------------------------------------------------------

export const accessRequests = orgSchema.table(
  "access_requests",
  {
    ...idMixin("arq"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    requesterId: uuid("requester_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    // CHECK: scope_kind IN ('org','workspace')
    scopeKind: text("scope_kind").notNull(),
    scopeId: uuid("scope_id").notNull(),
    // CHECK: status IN ('pending','approved','denied','expired')
    status: text("status").notNull().default("pending"),
    approverId: uuid("approver_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    ttlSeconds: text("ttl_seconds"),
    justification: text("justification"),
  },
  (t) => ({
    requesterIdx: index("access_requests_requester_idx").on(t.requesterId),
    orgStatusIdx: index("access_requests_org_status_idx").on(t.orgId, t.status),
    statusCheck: check(
      "access_requests_status_check",
      sql`${t.status} IN ('pending', 'approved', 'denied', 'expired')`,
    ),
    scopeKindCheck: check(
      "access_requests_scope_kind_check",
      sql`${t.scopeKind} IN ('org', 'workspace')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// sessions (IAM) — principal session lifecycle (active + revoked)
//
// APPEND-LEANING: no updated_at / updated_by columns. Sessions are created
// once; revocation is tracked via revoked_at + revoked_by, never via UPDATE
// to an existing record. Use iamSessions to avoid name collision with
// auth.sessions (exported from auth.ts).
// ---------------------------------------------------------------------------

export const iamSessions = orgSchema.table(
  "iam_sessions",
  {
    ...idMixin("ses"),
    orgId: uuid("org_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    ip: text("ip"),
    userAgent: text("ua"),
    idpSessionId: text("idp_session_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
    // audit — created timestamp only (no updated_at per append-leaning policy)
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => ({
    // Resolver hot path: "is this principal's session still active?"
    principalIdx: index("iam_sessions_principal_idx").on(t.principalId),
    orgIdx: index("iam_sessions_org_idx").on(t.orgId),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types — re-exported so callers need only one import path.
// ---------------------------------------------------------------------------

export type IamPrincipal = typeof principals.$inferSelect;
export type NewIamPrincipal = typeof principals.$inferInsert;

export type IamRole = typeof roles.$inferSelect;
export type NewIamRole = typeof roles.$inferInsert;

export type IamRoleGrant = typeof roleGrants.$inferSelect;
export type NewIamRoleGrant = typeof roleGrants.$inferInsert;

export type IamGrant = typeof grants.$inferSelect;
export type NewIamGrant = typeof grants.$inferInsert;

export type IamPolicy = typeof policies.$inferSelect;
export type NewIamPolicy = typeof policies.$inferInsert;

export type IamAccessRequest = typeof accessRequests.$inferSelect;
export type NewIamAccessRequest = typeof accessRequests.$inferInsert;

export type IamSession = typeof iamSessions.$inferSelect;
export type NewIamSession = typeof iamSessions.$inferInsert;
