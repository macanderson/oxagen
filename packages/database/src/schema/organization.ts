import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationSchema } from "./_schemas.js";
import { auditMixin, citext, idMixin } from "./_mixins.js";

export const tenants = organizationSchema.table(
  "tenants",
  {
    ...idMixin("ten"),
    ...auditMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    planType: text("plan_type").notNull(),
    status: text("status").notNull(),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug),
    statusIdx: index("tenants_status_idx").on(t.status),
  }),
);

export const tenantUsers = organizationSchema.table(
  "tenant_users",
  {
    ...idMixin("tnu"),
    ...auditMixin(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    tenantUserIdx: uniqueIndex("tenant_users_tenant_user_idx").on(t.tenantId, t.userId),
    userIdx: index("tenant_users_user_idx").on(t.userId),
  }),
);

export const tenantSlugHistory = organizationSchema.table(
  "tenant_slug_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    oldSlug: citext("old_slug").notNull(),
    newSlug: citext("new_slug").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" }).notNull(),
    redirectEnabled: boolean("redirect_enabled").notNull().default(true),
  },
  (t) => ({
    oldSlugIdx: index("tenant_slug_history_old_slug_idx").on(t.oldSlug),
    tenantIdx: index("tenant_slug_history_tenant_idx").on(t.tenantId),
  }),
);
