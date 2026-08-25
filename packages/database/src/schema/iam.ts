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
  bigint,
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
import {
  appendOnlyAuditMixin,
  auditMixin,
  idMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";

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
    // One principal per (org, delegated-human). fetch-authz.ts resolves a
    // human/API-key to its principal via WHERE org_id=? AND parent_user_id=?
    // LIMIT 1; without this, concurrent provisioning could insert duplicates
    // and the LIMIT 1 would pick one non-deterministically (an owner could
    // resolve to a role-less principal and be spuriously denied). Partial so
    // org-level service principals (parent_user_id NULL) are unconstrained.
    // Narrowed to kind='human' (Agent RBAC Phase 1, migration
    // 20260805120000): a delegated agent principal legitimately shares the
    // same (org_id, parent_user_id) pair as its creator's human principal —
    // one human may create many agents, each with its own principal row.
    orgParentUserUniq: uniqueIndex("principals_org_parent_user_uniq")
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
    // Agent RBAC (docs/specs/agent-rbac/spec.md §3.3): same conditionsJsonb
    // shape as a future direct-grant conditions column — currently only the
    // typed `resourceScope` key is populated (by tools/scripts/seed-iam-defaults.ts
    // for the three system agent roles). Nullable/absent means "no ceiling
    // beyond the effect" — packages/oxagen/src/iam/resolve.ts's RoleGrant type
    // and collectResourceScope() are the readers; this column is what makes
    // that already-landed resolver logic reachable from real data.
    conditionsJsonb: jsonb("conditions_jsonb"),
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
    // FK to iam.principals — the subject being assigned a role.
    principalId: uuid("principal_id").notNull(),
    // FK to iam.roles — the role being assigned.
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
// Governed-run authorization foundation (docs/specs/run-evidence-ingress)
//
// Four tables that together replace the once-per-run unrefreshed IAM decision
// cache with a PINNED grant ceiling plus a LIVE deny check:
//
//   authorization_snapshots      immutable — the ceiling, resolved at admission
//   authorization_deny_generations  mutable — the monotonic invalidation counter
//   emergency_denies             mutable  — operator deny policy
//   authorization_decisions      immutable — one row per governed operation
//
// The asymmetry is the point: the snapshot can only ever NARROW during a run.
// A later or replacement grant cannot revive an expired member of the pinned
// ceiling, while a suspension, revocation, or emergency deny takes effect
// before the next operation because the generation moved.
//
// These tables declare their scope columns inline rather than using
// orgScopeMixin(), matching the convention at the top of this file: several of
// them are legitimately org-wide (workspace_id NULL).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// authorization_snapshots — immutable pinned grant ceiling (`ras_`)
// ---------------------------------------------------------------------------

export const authorizationSnapshots = iamSchema.table(
  "authorization_snapshots",
  {
    ...idMixin("ras"),
    ...appendOnlyAuditMixin(),
    orgId: uuid("org_id").notNull(),
    // A governed run always executes in one workspace, so this is NOT NULL
    // unlike principals/assignments above.
    workspaceId: uuid("workspace_id").notNull(),
    // The authenticated human who delegated the run. Deliberately NOT
    // `principals.parent_user_id`: that column is the agent's creator, which is
    // not necessarily who authorized this execution.
    initiatingPrincipalId: uuid("initiating_principal_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    // The canonical human ∩ agent ceiling. Preserves assignment IDs, role IDs,
    // conditions, resource scopes, and each assignment/grant expiry — it is NOT
    // flattened into a capability allowlist, because a flattened list could be
    // silently refreshed from later grants and would lose per-binding expiry.
    grantCeiling: jsonb("grant_ceiling").notNull(),
    grantCeilingDigest: text("grant_ceiling_digest").notNull(),
    // Digest over the whole snapshot (ceiling + principals + generations).
    snapshotDigest: text("snapshot_digest").notNull(),
    // The deny-generation vector observed at resolution. Any later value means
    // cached allows are stale and must be re-derived.
    orgDenyGeneration: bigint("org_deny_generation", {
      mode: "number",
    }).notNull(),
    workspaceDenyGeneration: bigint("workspace_deny_generation", {
      mode: "number",
    }).notNull(),
    // The earliest instant at which some member of the ceiling expires. Null
    // means nothing in the ceiling expires on a clock.
    nextValidityBoundaryAt: timestamp("next_validity_boundary_at", {
      withTimezone: true,
      mode: "date",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index("authorization_snapshots_org_idx").on(t.orgId, t.workspaceId),
    principalsIdx: index("authorization_snapshots_principals_idx").on(
      t.orgId,
      t.initiatingPrincipalId,
      t.agentPrincipalId,
    ),
    generationCheck: check(
      "authorization_snapshots_generation_check",
      sql`${t.orgDenyGeneration} >= 0 AND ${t.workspaceDenyGeneration} >= 0`,
    ),
    digestCheck: check(
      "authorization_snapshots_digest_check",
      sql`${t.grantCeilingDigest} ~ '^sha256:[0-9a-f]{64}$' AND ${t.snapshotDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    // A delegation is between two distinct principals; a self-delegation would
    // mean the ceiling is not actually an intersection.
    principalsDistinctCheck: check(
      "authorization_snapshots_principals_distinct_check",
      sql`${t.initiatingPrincipalId} <> ${t.agentPrincipalId}`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// authorization_deny_generations — mutable monotonic invalidation counter
// ---------------------------------------------------------------------------
//
// One row per org scope and per workspace scope. Security-definer triggers on
// principals, principal_role_assignments, roles, role_grants, and
// emergency_denies bump the counter IN THE SAME TRANSACTION as the change, so a
// suspension is visible to the next authorization check without any cache
// invalidation message.
//
// `oxagen_app` gets SELECT only (see the migration): the application role can
// read the generation but cannot decrement or reset it, because doing so would
// silently revive every cached allow.
export const authorizationDenyGenerations = iamSchema.table(
  "authorization_deny_generations",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    // NULL = the org-wide scope row.
    workspaceId: uuid("workspace_id"),
    scopeKind: text("scope_kind").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Standard UNIQUE treats NULLs as distinct, so the org scope needs its own
    // partial index — same pattern as pra_principal_role_org_null_workspace_idx.
    orgScopeUniq: uniqueIndex("authorization_deny_generations_org_uq")
      .on(t.orgId)
      .where(sql`workspace_id IS NULL`),
    workspaceScopeUniq: uniqueIndex(
      "authorization_deny_generations_workspace_uq",
    )
      .on(t.orgId, t.workspaceId)
      .where(sql`workspace_id IS NOT NULL`),
    scopeKindCheck: check(
      "authorization_deny_generations_scope_kind_check",
      sql`(${t.scopeKind} = 'org' AND ${t.workspaceId} IS NULL) OR (${t.scopeKind} = 'workspace' AND ${t.workspaceId} IS NOT NULL)`,
    ),
    generationCheck: check(
      "authorization_deny_generations_generation_check",
      sql`${t.generation} >= 1`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// emergency_denies — mutable operator deny policy (`emd_`)
// ---------------------------------------------------------------------------
//
// Typed, not free-form: a deny targets either a capability or a resource scope,
// never both, so the live check is an index lookup rather than a policy
// evaluation. Deactivation sets `active = false` (and keeps the row) instead of
// deleting, so the audit trail of what was denied when survives; the migration
// revokes DELETE accordingly.
export const emergencyDenies = iamSchema.table(
  "emergency_denies",
  {
    ...idMixin("emd"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    // NULL = an org-wide deny.
    workspaceId: uuid("workspace_id"),
    scopeKind: text("scope_kind").notNull(),
    denyKind: text("deny_kind").notNull(),
    capabilityId: text("capability_id"),
    resourceScopeDigest: text("resource_scope_digest"),
    // Optional narrowing to one principal; NULL denies for every principal in
    // the scope.
    principalId: uuid("principal_id"),
    reason: text("reason").notNull(),
    active: boolean("active").notNull().default(true),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // The live-check index: only active denies are ever scanned.
    activeIdx: index("emergency_denies_active_idx")
      .on(t.orgId, t.workspaceId, t.denyKind, t.capabilityId)
      .where(sql`active = true`),
    orgIdx: index("emergency_denies_org_idx").on(t.orgId, t.workspaceId),
    principalIdx: index("emergency_denies_principal_idx")
      .on(t.principalId)
      .where(sql`principal_id IS NOT NULL`),
    scopeKindCheck: check(
      "emergency_denies_scope_kind_check",
      sql`(${t.scopeKind} = 'org' AND ${t.workspaceId} IS NULL) OR (${t.scopeKind} = 'workspace' AND ${t.workspaceId} IS NOT NULL)`,
    ),
    denyKindCheck: check(
      "emergency_denies_deny_kind_check",
      sql`(${t.denyKind} = 'capability' AND ${t.capabilityId} IS NOT NULL AND ${t.resourceScopeDigest} IS NULL) OR (${t.denyKind} = 'resource_scope' AND ${t.resourceScopeDigest} IS NOT NULL AND ${t.capabilityId} IS NULL)`,
    ),
    activeCheck: check(
      "emergency_denies_active_check",
      sql`(${t.active} = true AND ${t.deactivatedAt} IS NULL) OR (${t.active} = false AND ${t.deactivatedAt} IS NOT NULL)`,
    ),
    digestCheck: check(
      "emergency_denies_digest_check",
      sql`${t.resourceScopeDigest} IS NULL OR ${t.resourceScopeDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// authorization_decisions — immutable decision record (`azd_`)
// ---------------------------------------------------------------------------
//
// One row per governed operation, for allow, deny, approval-pending, AND
// evaluation error. The kernel creates it; a caller can never supply a decision
// reference, and agent-run execution fails closed if the row cannot be
// inserted — an unrecorded decision is not an allowed one.
export const authorizationDecisions = iamSchema.table(
  "authorization_decisions",
  {
    ...idMixin("azd"),
    ...appendOnlyAuditMixin(),
    orgId: uuid("org_id").notNull(),
    // NULL for org-scoped operations that precede a workspace selection.
    workspaceId: uuid("workspace_id"),
    capabilityId: text("capability_id").notNull(),
    // The kernel request/trace correlation id this decision belongs to.
    requestId: text("request_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    // For a delegated agent call, the human whose ceiling was intersected.
    onBehalfOfPrincipalId: uuid("on_behalf_of_principal_id"),
    scopeKind: text("scope_kind").notNull(),
    resourceScopeDigest: text("resource_scope_digest"),
    // Complete run bindings, or none — a partial binding cannot be audited back
    // to an attempt.
    runId: uuid("run_id"),
    attemptId: uuid("attempt_id"),
    authorizationSnapshotId: uuid("authorization_snapshot_id"),
    // The generation vector this decision was evaluated against. A decision
    // read back at a higher generation is known-stale by inspection.
    orgDenyGeneration: bigint("org_deny_generation", {
      mode: "number",
    }).notNull(),
    workspaceDenyGeneration: bigint("workspace_deny_generation", {
      mode: "number",
    }),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    approvalRequestId: uuid("approval_request_id"),
    inputDigest: text("input_digest").notNull(),
    traceDigest: text("trace_digest"),
    decisionDigest: text("decision_digest").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index("authorization_decisions_org_idx").on(t.orgId, t.workspaceId),
    // Attempt-scoped audit read: "every decision this attempt made, in order".
    attemptIdx: index("authorization_decisions_attempt_idx")
      .on(t.attemptId, t.decidedAt)
      .where(sql`attempt_id IS NOT NULL`),
    capabilityOutcomeIdx: index(
      "authorization_decisions_capability_outcome_idx",
    ).on(t.orgId, t.capabilityId, t.outcome, t.decidedAt),
    requestIdx: index("authorization_decisions_request_idx").on(t.requestId),
    outcomeCheck: check(
      "authorization_decisions_outcome_check",
      sql`${t.outcome} IN ('allow', 'deny', 'approval_pending', 'error')`,
    ),
    scopeKindCheck: check(
      "authorization_decisions_scope_kind_check",
      sql`(${t.scopeKind} = 'org' AND ${t.workspaceId} IS NULL) OR (${t.scopeKind} = 'workspace' AND ${t.workspaceId} IS NOT NULL)`,
    ),
    runBindingCheck: check(
      "authorization_decisions_run_binding_check",
      sql`(
        ${t.runId} IS NULL
        AND ${t.attemptId} IS NULL
        AND ${t.authorizationSnapshotId} IS NULL
      ) OR (
        ${t.runId} IS NOT NULL
        AND ${t.attemptId} IS NOT NULL
        AND ${t.authorizationSnapshotId} IS NOT NULL
      )`,
    ),
    // A workspace-scoped decision must record the workspace generation it saw;
    // an org-scoped one has no workspace generation to record.
    generationCheck: check(
      "authorization_decisions_generation_check",
      sql`${t.orgDenyGeneration} >= 0 AND (${t.workspaceId} IS NULL) = (${t.workspaceDenyGeneration} IS NULL) AND (${t.workspaceDenyGeneration} IS NULL OR ${t.workspaceDenyGeneration} >= 0)`,
    ),
    // An approval-pending outcome must name the approval it is waiting on.
    approvalCheck: check(
      "authorization_decisions_approval_check",
      sql`(${t.outcome} = 'approval_pending') = (${t.approvalRequestId} IS NOT NULL)`,
    ),
    digestCheck: check(
      "authorization_decisions_digest_check",
      sql`${t.inputDigest} ~ '^sha256:[0-9a-f]{64}$' AND ${t.decisionDigest} ~ '^sha256:[0-9a-f]{64}$' AND (${t.traceDigest} IS NULL OR ${t.traceDigest} ~ '^sha256:[0-9a-f]{64}$') AND (${t.resourceScopeDigest} IS NULL OR ${t.resourceScopeDigest} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
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

export type IamAuthorizationSnapshot =
  typeof authorizationSnapshots.$inferSelect;
export type NewIamAuthorizationSnapshot =
  typeof authorizationSnapshots.$inferInsert;

export type IamAuthorizationDenyGeneration =
  typeof authorizationDenyGenerations.$inferSelect;

export type IamEmergencyDeny = typeof emergencyDenies.$inferSelect;
export type NewIamEmergencyDeny = typeof emergencyDenies.$inferInsert;

export type IamAuthorizationDecision =
  typeof authorizationDecisions.$inferSelect;
export type NewIamAuthorizationDecision =
  typeof authorizationDecisions.$inferInsert;
