import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceSchema } from "./_schemas.js";
import { auditMixin, citext, idMixin, ltree, tenantScopeMixin } from "./_mixins.js";

export const workspaces = workspaceSchema.table(
  "workspaces",
  {
    ...idMixin("wrk"),
    ...auditMixin(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    defaultGraphId: uuid("default_graph_id"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("workspaces_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantIdx: index("workspaces_tenant_idx").on(t.tenantId),
  }),
);

export const workspaceUsers = workspaceSchema.table(
  "workspace_users",
  {
    ...idMixin("wsu"),
    ...auditMixin(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    workspaceUserIdx: uniqueIndex("workspace_users_workspace_user_idx").on(t.workspaceId, t.userId),
    userIdx: index("workspace_users_user_idx").on(t.userId),
  }),
);

export const folders = workspaceSchema.table(
  "folders",
  {
    ...idMixin("fld"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    parentFolderId: uuid("parent_folder_id"),
    name: text("name").notNull(),
    path: ltree("path").notNull(),
  },
  (t) => ({
    tenantIdx: index("folders_tenant_idx").on(t.tenantId, t.workspaceId),
    // GIST index on ltree path enables subtree containment queries
    // (path <@ ancestor) without sequential scans. Hand-written in the
    // initial migration since Drizzle has no first-class GIST helper.
    pathIdx: index("folders_path_idx").on(t.path),
  }),
);

export const workspaceSlugHistory = workspaceSchema.table(
  "workspace_slug_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    oldSlug: citext("old_slug").notNull(),
    newSlug: citext("new_slug").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" }).notNull(),
    redirectEnabled: boolean("redirect_enabled").notNull().default(true),
  },
  (t) => ({
    oldSlugIdx: index("workspace_slug_history_old_slug_idx").on(t.workspaceId, t.oldSlug),
  }),
);
