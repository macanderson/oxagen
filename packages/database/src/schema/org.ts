import { boolean, check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgSchema } from "./_schemas";
import { auditMixin, citext, idMixin } from "./_mixins";

export const organizations = orgSchema.table(
  "organizations",
  {
    ...idMixin("org"),
    ...auditMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    // Immutable, globally-unique handle (like a Linear team key). SEPARATE from
    // slug on purpose: slugs are renameable (org_slug_history), namespaces never
    // change once set (enforced by the organizations_namespace_immutable
    // trigger). It anchors the agentKey org_ns.workspace_ns.agent_slug, whose
    // 32-char budget is 6 (org) + 1 + 6 (workspace) + 1 + 18 (agent slug).
    // Derived from the slug at creation via deriveNamespace().
    namespace: citext("namespace").notNull(),
    // Org avatar/logo. Nullable: orgs render initials until a logo is uploaded.
    // Stores the public blob URL returned by the storage adapter (Vercel Blob).
    avatarUrl: text("avatar_url"),
    planType: text("plan_type").notNull(),
    status: text("status").notNull(),
    // Discriminator: 'personal' = solo user, 'business' = team/company.
    // Business orgs unlock team features, billing profiles, and enterprise
    // controls. CHECK enforced below.
    type: text("type").notNull().default("business"),
    // Business-only profile fields. NULL on personal orgs.
    website: text("website"),
    industry: text("industry"),
    // CHECK: closed size-range slugs or NULL (personal orgs omit).
    employeeSize: text("employee_size"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    slugIdx: uniqueIndex("organizations_slug_idx").on(t.slug),
    // Namespace is globally unique + immutable. The immutability itself is
    // enforced by a BEFORE UPDATE trigger (see migration
    // 20260709120000_namespace_identity), not expressible in Drizzle DDL.
    namespaceIdx: uniqueIndex("organizations_namespace_idx").on(t.namespace),
    namespaceCheck: check(
      "organizations_namespace_check",
      sql`${t.namespace} ~ '^[a-z0-9]{2,6}$'`,
    ),
    statusIdx: index("organizations_status_idx").on(t.status),
    typeCheck: check(
      "organizations_type_check",
      sql`${t.type} IN ('personal','business')`,
    ),
    // NULL is valid (personal orgs and business orgs that skipped the field).
    employeeSizeCheck: check(
      "organizations_employee_size_check",
      sql`${t.employeeSize} IS NULL OR ${t.employeeSize} IN ('1','2-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10000+')`,
    ),
    statusCheck: check("organizations_status_check", sql`${t.status} IN ('active', 'suspended', 'deleted')`),
  }),
);

export const orgUsers = orgSchema.table(
  "org_users",
  {
    ...idMixin("oru"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    orgUserIdx: uniqueIndex("org_users_org_user_idx").on(t.orgId, t.userId),
    userIdx: index("org_users_user_idx").on(t.userId),
    // Membership role is written in BOTH casings today: lowercase by the
    // org/workspace create + onboarding paths, Capitalized by
    // workspace.invite.send's mapRole() and the IAM-role-name path in
    // org.member.role.change. Case-insensitive CHECK over the canonical role
    // set (iam-provision.ts ORG_ROLES/WORKSPACE_ROLES — a fixed seeded set, no
    // custom-role path) rejects garbage without breaking either writer.
    roleCheck: check(
      "org_users_role_check",
      sql`lower(${t.role}) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer')`,
    ),
  }),
);

// ── Invitations ───────────────────────────────────────────────────────────────
// Each invitation occupies a seat (pending invites count as used seats).
// One active invitation per (orgId, email); multiple can exist historically
// (accepted/declined/revoked/expired are not blocked by the partial unique index).

// Slug-history capture for org renames. Every time organizations.slug changes,
// the write path inserts one row in the SAME transaction as the slug UPDATE
// (atomic capture). The resolver consults this table on a current-slug miss to
// 301/308-redirect the old URL to the canonical new one (spec §4.5, §6.1).
// redirect_enabled=false freezes a row so the old URL 404s again — used when a
// slug is intentionally retired or recycled.
//
// old_slug is intentionally NOT unique: a re-rename chain (a→b, then b→c, then
// a→c by another org after the first org freed "a") can produce repeated
// old_slug values. The resolver picks the most recent matching row by
// changed_at DESC.
export const orgSlugHistory = orgSchema.table(
  "org_slug_history",
  {
    ...idMixin("osh"),
    orgId: uuid("org_id").notNull(),
    oldSlug: citext("old_slug").notNull(),
    newSlug: citext("new_slug").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    redirectEnabled: boolean("redirect_enabled").notNull().default(true),
  },
  (t) => ({
    // Resolver hot path: lookup by old_slug.
    oldSlugIdx: index("org_slug_history_old_slug_idx").on(t.oldSlug),
    // Inverse lookup for admin tooling ("show rename history for this org").
    orgIdx: index("org_slug_history_org_idx").on(t.orgId, t.changedAt),
  }),
);

export const invitations = orgSchema.table(
  "invitations",
  {
    ...idMixin("invi"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    // citext for case-insensitive uniqueness
    email: citext("email").notNull(),
    // The org role to assign on accept (e.g. 'Admin', 'Member')
    role: text("role").notNull(),
    // CHECK: status IN ('pending','accepted','declined','revoked','expired')
    status: text("status").notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    acceptedUserId: uuid("accepted_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Fast lookup: active invitations for an org
    orgStatusIdx: index("invitations_org_status_idx").on(t.orgId, t.status),
    // Prevent duplicate pending invitations for the same email in an org
    pendingEmailIdx: uniqueIndex("invitations_org_email_pending_idx")
      .on(t.orgId, t.email)
      .where(sql`${t.status} = 'pending'`),
    statusCheck: check(
      "invitations_status_check",
      sql`${t.status} IN ('pending','accepted','declined','revoked','expired')`,
    ),
    // invitations.role holds the IAM role NAME to assign on accept — a value
    // from the fixed per-org seeded set (iam-provision.ts), stored Title-cased
    // (e.g. 'Admin', 'Member'). Case-insensitive CHECK over the canonical set;
    // there is no custom-role-creation path, so the set is closed.
    roleCheck: check(
      "invitations_role_check",
      sql`lower(${t.role}) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer')`,
    ),
  }),
);

