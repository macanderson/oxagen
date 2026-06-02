import { index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    planType: text("plan_type").notNull(),
    status: text("status").notNull(),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    slugIdx: uniqueIndex("organizations_slug_idx").on(t.slug),
    statusIdx: index("organizations_status_idx").on(t.status),
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

