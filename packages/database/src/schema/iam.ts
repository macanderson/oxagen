// iam.ts — IAM data layer (OXA-1389, Phase 2).
//
// All 5 IAM tables live in their own dedicated `iam` Postgres schema
// (`iamSchema = pgSchema("iam")` in ./_schemas). Atlas reads the desired state
// via `drizzle-kit export`, so these tables are picked up automatically — there
// is no drizzle-kit `schemaFilter` to maintain. There is NO IAM sessions table;
// auth sessions live in `auth.sessions` (see auth.ts).
//
// CRITICAL: Do NOT use orgScopeMixin() on these tables. orgScopeMixin() forces
// workspace_id NOT NULL, but principals/roles/role_grants are org-scoped
// entities that may not carry a workspace_id. All IAM tables declare their
// scope columns inline.
//
// The five tables and their public-id prefixes (spec §4.3):
//   principals                 → prn_
//   roles                      → rol_
//   role_grants                → rlg_
//   access_requests            → arq_
//   principal_role_assignments → pra_  (OXA-1498)

import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { iamSchema } from "./_schemas";
import { auditMixin, idMixin, softDeleteMixin } from "./_mixins";

// ---------------------------------------------------------------------------
// principals — every human, agent, or service in the system
// ---------------------------------------------------------------------------

export const principals = iamSchema.table(
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
    // One principal per (org, delegated-human) HUMAN. fetch-authz.ts resolves
    // a human/API-key to its principal via WHERE org_id=? AND parent_user_id=?
    // AND kind='human' LIMIT 1; without this, concurrent provisioning could
    // insert duplicates and the LIMIT 1 would pick one non-deterministically
    // (an owner could resolve to a role-less principal and be spuriously
    // denied). Scoped to kind='human' (not just parent_user_id IS NOT NULL):
    // agent principals ALSO carry parentUserId=creator (docs/specs/agent-rbac
    // /spec.md §3.1 — the delegation link), and a user may create many
    // agents, so (orgId, parentUserId) is deliberately NOT unique across
    // kinds. Only "the human's own principal" must be unique per (org, user).
    orgParentUserHumanUniq: uniqueIndex("principals_org_parent_user_human_uniq")
      .on(t.orgId, t.parentUserId)
      .where(sql`${t.parentUserId} IS NOT NULL AND ${t.kind} = 'human'`),
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

export const roles = iamSchema.table(
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
    isSystemDefault: boolean("is_system_default").notNull().default(false),
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

export const roleGrants = iamSchema.table(
  "role_grants",
  {
    ...idMixin("rlg"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    roleId: uuid("role_id").notNull(),
    // Capability identifier string (e.g. "org.create").
    // Not a FK — capability metadata lives on the contract objects, not a DB
    // table. Phase 3 (OXA-1390) will validate this at write time.
    capabilityId: text("capability_id").notNull(),
    // CHECK: effect IN ('allow','deny','require_approval')
    effect: text("effect").notNull(),
  },
  (t) => ({
    // Hot path: "what effect does this role have on this capability?"
    roleCapabilityIdx: index("role_grants_role_capability_idx").on(
      t.roleId,
      t.capabilityId,
    ),
    orgIdx: index("role_grants_org_idx").on(t.orgId),
    effectCheck: check(
      "role_grants_effect_check",
      sql`${t.effect} IN ('allow', 'deny', 'require_approval')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// access_requests — JIT access requests
// ---------------------------------------------------------------------------

export const accessRequests = iamSchema.table(
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
    ttlSeconds: integer("ttl_seconds"),
    justification: text("justification"),
  },
  (t) => ({
    requesterIdx: index("access_requests_requester_idx").on(t.requesterId),
    orgStatusIdx: index("access_requests_org_status_idx").on(t.orgId, t.status),
    // Race-safe dedupe: at most one 'pending' request per
    // (org, requester, capability, scope) tuple. createAccessRequest() catches
    // the resulting 23505 and re-selects the surviving row rather than relying
    // solely on its app-side SELECT-then-INSERT pre-check.
    pendingDedupeIdx: uniqueIndex("access_requests_pending_dedupe_idx")
      .on(t.orgId, t.requesterId, t.capabilityId, t.scopeKind, t.scopeId)
      .where(sql`${t.status} = 'pending'`),
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
// ---------------------------------------------------------------------------
// principal_role_assignments — maps a principal to a role within an org
// (and optionally a workspace) scope. Replaces the prior "grant everyone
// every role" shortcut. OXA-1498.
//
// Naming convention prefix: pra_
//
// Unique constraint: one (principal, role, org, workspace) tuple per row so
// idempotent upserts are safe. workspace_id NULL means org-wide scope.
// ---------------------------------------------------------------------------

export const principalRoleAssignments = iamSchema.table(
  "principal_role_assignments",
  {
    ...idMixin("pra"),
    ...auditMixin(),
    ...softDeleteMixin(),
    // FK to org.principals — the subject being assigned a role.
    principalId: uuid("principal_id").notNull(),
    // FK to org.roles — the role being assigned.
    roleId: uuid("role_id").notNull(),
    // Org this assignment lives in.
    orgId: uuid("org_id").notNull(),
    // Optional workspace scope. NULL = org-wide assignment.
    workspaceId: uuid("workspace_id"),
    // Who performed the assignment (audit trail).
    assignedBy: uuid("assigned_by"),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // Optional expiry for time-bounded role assignments (e.g. JIT access).
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Partial unique index for workspace-scoped assignments (workspace_id NOT NULL).
    principalRoleOrgWorkspaceUniq: uniqueIndex(
      "pra_principal_role_org_workspace_idx",
    )
      .on(t.principalId, t.roleId, t.orgId, t.workspaceId)
      .where(sql`${t.workspaceId} IS NOT NULL`),
    // Partial unique index for org-wide assignments (workspace_id IS NULL).
    // Standard UNIQUE treats NULLs as distinct; this closes the gap so two
    // org-wide (principal, role, org) assignments are correctly rejected.
    principalRoleOrgNullWorkspaceUniq: uniqueIndex(
      "pra_principal_role_org_null_workspace_idx",
    )
      .on(t.principalId, t.roleId, t.orgId)
      .where(sql`${t.workspaceId} IS NULL`),
    // Index to find all roles assigned to a principal in an org.
    principalOrgIdx: index("pra_principal_org_idx").on(t.principalId, t.orgId),
    // Index to find all principals assigned to a role.
    roleOrgIdx: index("pra_role_org_idx").on(t.roleId, t.orgId),
    // Index to resolve workspace-scoped assignments quickly.
    workspaceIdx: index("pra_workspace_idx").on(t.workspaceId),
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

export type IamAccessRequest = typeof accessRequests.$inferSelect;
export type NewIamAccessRequest = typeof accessRequests.$inferInsert;

export type IamPrincipalRoleAssignment =
  typeof principalRoleAssignments.$inferSelect;
export type NewIamPrincipalRoleAssignment =
  typeof principalRoleAssignments.$inferInsert;
