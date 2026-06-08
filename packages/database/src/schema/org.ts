import { check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  }),
);

// ── Invitations ───────────────────────────────────────────────────────────────
// Each invitation occupies a seat (pending invites count as used seats).
// One active invitation per (orgId, email); multiple can exist historically
// (accepted/declined/revoked/expired are not blocked by the partial unique index).

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
  }),
);

